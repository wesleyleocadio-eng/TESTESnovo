import { join } from 'node:path';
import { config as loadDotEnv } from 'dotenv';
import { checkDotEnv, checkEnvironments } from '../doctor/checks.ts';
import type { Redactor } from '../security/redact.ts';
import type { SecretStore } from '../security/secrets.ts';
import { loadConfig, referencedEnvVars } from './load.ts';
import type { Config } from './schema.ts';

/**
 * Recarrega .env e config/*.yaml dentro do servidor em execução. Atualiza os objetos
 * compartilhados em lugar (mesma referência para store, navegador e guard), libera as
 * novas referências de segredo e passa a redigir as senhas novas.
 */
export function reloadConfig(deps: { rootDir: string; config: Config; secrets: SecretStore; redactor: Redactor }) {
  loadDotEnv({ path: join(deps.rootDir, '.env'), override: true, quiet: true });
  const fresh = loadConfig(deps.rootDir); // lança ConfigError com todos os problemas
  deps.config.projects = fresh.projects;
  deps.config.environments = fresh.environments;
  deps.config.policy = fresh.policy;
  deps.secrets.allow(referencedEnvVars(fresh));
  deps.redactor.configure({ secrets: deps.secrets.valuesForRedaction(), extraSensitiveKeys: fresh.policy.redaction.extraSensitiveKeys });
  const dotenv = checkDotEnv(deps.rootDir);
  return {
    environments: checkEnvironments(fresh, process.env).map((c) => `${c.status === 'ok' ? '✓' : '!'} ${c.name}: ${c.detail}`),
    ...(dotenv.status === 'fail' ? { dotenvProblem: dotenv.detail } : {}),
  };
}
