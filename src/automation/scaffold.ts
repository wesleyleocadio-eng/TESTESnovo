import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isEnvRef } from '../config/load.ts';
import type { Config, ConfigValue } from '../config/schema.ts';

/**
 * Estrutura de automação de um projeto: automation/<projeto>/.
 * `env.ts` é regenerado (espelha config/environments.yaml); config, fixtures e pastas
 * só são criados se não existirem — o que o Claude/QA editar não é sobrescrito.
 */

const value = (v: ConfigValue) => (isEnvRef(v) ? `{ env: '${v.env}' }` : `{ literal: ${JSON.stringify(v)} }`);

function envTs(config: Config, project: string): string {
  const envs = Object.entries(config.environments).filter(([, e]) => e.project === project);
  const entries = envs.map(([id, e]) => {
    const roles = Object.entries(e.roles).map(([r, role]) => `      ${JSON.stringify(r)}: { username: ${value(role.username)}, password: { env: '${role.password.env}' } },`).join('\n');
    return `  ${JSON.stringify(id)}: {\n    type: '${e.type}',\n    baseUrl: ${value(e.baseUrl)},\n    roles: {\n${roles}\n    },\n  },`;
  });
  const fallback = envs.find(([, e]) => e.type !== 'prod')?.[0] ?? '';
  return `// GERADO pelo NOVO QA a partir de config/environments.yaml — não edite: rode automation_spec de novo.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';

config({ path: join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.env'), quiet: true });

type Value = { env: string } | { literal: string };
interface Env { type: 'local' | 'dev' | 'staging' | 'prod'; baseUrl: Value; roles: Record<string, { username: Value; password: { env: string } }> }

const ENVIRONMENTS: Record<string, Env> = {
${entries.join('\n')}
};

export const ENV_ID = process.env.NOVO_QA_ENV ?? ${JSON.stringify(fallback)};
const env = ENVIRONMENTS[ENV_ID];
if (!env) throw new Error(\`NOVO_QA_ENV="\${ENV_ID}" não é um ambiente deste projeto (\${Object.keys(ENVIRONMENTS).join(', ')})\`);
// A automação gerada não roda em produção (lá o NOVO QA só permite ações GREEN).
if (env.type === 'prod') throw new Error(\`ambiente \${ENV_ID} é produção: automação do NOVO QA não roda em prod\`);

function read(v: Value, what: string): string {
  if ('literal' in v) return v.literal;
  const got = process.env[v.env];
  if (!got) throw new Error(\`\${what}: defina \${v.env} no .env\`);
  return got;
}

export function baseURL(): string {
  return process.env.NOVO_QA_BASE_URL ?? read(env.baseUrl, 'baseUrl');
}

export function credentials(role: string): { username: string; password: string } {
  const r = env.roles[role];
  if (!r) throw new Error(\`papel "\${role}" não existe em \${ENV_ID} (\${Object.keys(env.roles).join(', ')})\`);
  return { username: read(r.username, \`usuário de \${role}\`), password: read(r.password, \`senha de \${role}\`) };
}
`;
}

const CONFIG = `import { defineConfig, devices } from '@playwright/test';
import { baseURL } from './env.ts';

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  // Sem retry: flakiness tem de aparecer na validação, não ser escondida.
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 5_000 },
  reporter: [['list']],
  use: {
    baseURL: baseURL(),
    // A ação falha antes do teste, com o seletor na mensagem (senão só se vê "Test timeout").
    actionTimeout: 10_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
`;

const FIXTURES = `import { randomUUID } from 'node:crypto';
import { test as base, expect } from '@playwright/test';

/**
 * Valor único para massa criada pelo teste. Date.now() sozinho colide quando o mesmo
 * teste roda em paralelo (validação com --repeat-each, workers): use isto.
 */
export function unique(prefix: string): string {
  return \`\${prefix} \${Date.now().toString(36)}-\${randomUUID().slice(0, 8)}\`;
}

/**
 * Guard da automação: DELETE disparado pela página é bloqueado, como no teste manual.
 * Cenário que exclui pela UI declara o caminho: test.use({ allowDelete: ['/api/recurso'] }).
 * Limpeza de dados no afterEach usa o fixture \`request\`, que não passa por aqui.
 */
export const test = base.extend<{ allowDelete: string[] }>({
  allowDelete: [[], { option: true }],
  page: async ({ page, allowDelete }, use, testInfo) => {
    await page.route('**/*', (route) => {
      const req = route.request();
      if (req.method() !== 'DELETE') return route.continue();
      const path = new URL(req.url()).pathname;
      if (allowDelete.some((p) => path.startsWith(p))) return route.continue();
      testInfo.annotations.push({ type: 'novo-qa-blocked', description: \`DELETE \${path}\` });
      return route.abort('blockedbyclient');
    });
    await use(page);
  },
});

export { expect };
`;

export function scaffoldProject(rootDir: string, config: Config, project: string): { dir: string; created: string[] } {
  if (!config.projects[project]) throw new Error(`projeto ${project} não existe em config/projects.yaml`);
  const dir = join(rootDir, 'automation', project);
  const created: string[] = [];
  const ensure = (rel: string, content: string, overwrite = false) => {
    const path = join(dir, rel);
    if (existsSync(path) && !overwrite) return;
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content);
    created.push(`automation/${project}/${rel}`);
  };
  ensure('env.ts', envTs(config, project), true);
  ensure('playwright.config.ts', CONFIG);
  ensure('fixtures/index.ts', FIXTURES);
  ensure('pages/.gitkeep', '');
  ensure('tests/.gitkeep', '');
  return { dir: `automation/${project}`, created };
}
