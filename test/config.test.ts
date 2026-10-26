import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, referencedEnvVars, resolveValue } from '../src/config/load.ts';

const REPO_ROOT = join(import.meta.dirname, '..');
const dirs: string[] = [];

/** Copia config/ real para um diretório temporário e aplica uma alteração em um arquivo. */
function withConfig(file?: string, transform?: (yaml: string) => string): string {
  const dir = mkdtempSync(join(tmpdir(), 'novo-qa-config-'));
  dirs.push(dir);
  cpSync(join(REPO_ROOT, 'config'), join(dir, 'config'), { recursive: true });
  if (file && transform) {
    const path = join(dir, 'config', file);
    writeFileSync(path, transform(readFileSync(path, 'utf8')));
  }
  return dir;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function problemsOf(fn: () => unknown): string[] {
  try {
    fn();
  } catch (err) {
    if (err instanceof ConfigError) return err.problems;
    throw err;
  }
  throw new Error('esperava ConfigError');
}

describe('loadConfig', () => {
  it('carrega a config do repositório', () => {
    const config = loadConfig(REPO_ROOT);
    expect(config.environments['fixture-local']?.type).toBe('local');
    expect(config.policy.guard.allowedLevels.prod).toEqual(['GREEN']);
  });

  it('rejeita senha literal', () => {
    const dir = withConfig('environments.yaml', (y) =>
      y.replace('password: { env: FIXTURE_ADMIN_PASSWORD }', 'password: minhasenha'),
    );
    expect(problemsOf(() => loadConfig(dir)).join()).toMatch(/roles\.admin\.password/);
  });

  it('rejeita prod permitindo algo além de GREEN', () => {
    const dir = withConfig('qa-policy.yaml', (y) => y.replace('prod: [GREEN]', 'prod: [GREEN, YELLOW]'));
    expect(problemsOf(() => loadConfig(dir)).join()).toMatch(/prod só pode permitir GREEN/);
  });

  it('rejeita ambiente apontando para projeto inexistente', () => {
    const dir = withConfig('environments.yaml', (y) => y.replace('project: fixture', 'project: inexistente'));
    expect(problemsOf(() => loadConfig(dir)).join()).toMatch(/projeto "inexistente" não existe/);
  });

  it('rejeita tipo de ambiente desconhecido e chave não prevista', () => {
    const dir = withConfig('environments.yaml', (y) => y.replace('    type: local', '    type: producao\n    extra: 1'));
    const problems = problemsOf(() => loadConfig(dir)).join('\n');
    expect(problems).toMatch(/type/);
    expect(problems).toMatch(/extra/);
  });

  it('reporta YAML malformado com o caminho do arquivo', () => {
    const dir = withConfig('projects.yaml', () => 'projects: [');
    expect(problemsOf(() => loadConfig(dir))[0]).toMatch(/projects\.yaml/);
  });
});

describe('resolveValue / referencedEnvVars', () => {
  it('resolve literal e referência; vazio conta como ausente', () => {
    expect(resolveValue('http://x')).toBe('http://x');
    expect(resolveValue({ env: 'A_URL' }, { A_URL: 'http://a' })).toBe('http://a');
    expect(resolveValue({ env: 'A_URL' }, { A_URL: '' })).toBeUndefined();
  });

  it('lista variáveis referenciadas', () => {
    expect(referencedEnvVars(loadConfig(REPO_ROOT))).toContain('FIXTURE_ADMIN_PASSWORD');
  });
});
