import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import type { z } from 'zod';
import {
  EnvironmentsFile,
  PolicyFile,
  ProjectsFile,
  type Config,
  type ConfigValue,
  type EnvRef,
} from './schema.ts';

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Configuração inválida:\n- ${problems.join('\n- ')}`);
    this.name = 'ConfigError';
  }
}

function readYaml<S extends z.ZodType>(path: string, schema: S, problems: string[]): z.infer<S> | undefined {
  let raw: unknown;
  try {
    raw = parse(readFileSync(path, 'utf8'));
  } catch (err) {
    problems.push(`${path}: ${(err as Error).message}`);
    return undefined;
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    for (const issue of result.error.issues) {
      problems.push(`${path}: ${issue.path.join('.') || '(raiz)'}: ${issue.message}`);
    }
    return undefined;
  }
  return result.data;
}

/** Carrega e valida config/*.yaml. Lança ConfigError com todos os problemas encontrados. */
export function loadConfig(rootDir: string): Config {
  const dir = join(rootDir, 'config');
  const problems: string[] = [];
  const projects = readYaml(join(dir, 'projects.yaml'), ProjectsFile, problems);
  const environments = readYaml(join(dir, 'environments.yaml'), EnvironmentsFile, problems);
  const policy = readYaml(join(dir, 'qa-policy.yaml'), PolicyFile, problems);

  if (projects && environments) {
    for (const [envId, env] of Object.entries(environments.environments)) {
      if (!projects.projects[env.project]) {
        problems.push(`environments.${envId}.project: projeto "${env.project}" não existe em projects.yaml`);
      }
    }
  }
  if (problems.length > 0 || !projects || !environments || !policy) throw new ConfigError(problems);

  return { projects: projects.projects, environments: environments.environments, policy };
}

export function isEnvRef(value: ConfigValue): value is EnvRef {
  return typeof value === 'object';
}

/** Resolve um valor de config; undefined se a variável referenciada não estiver definida. */
export function resolveValue(value: ConfigValue, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!isEnvRef(value)) return value;
  const resolved = env[value.env];
  return resolved === undefined || resolved === '' ? undefined : resolved;
}

/** Nomes de todas as variáveis de ambiente referenciadas pela config. */
export function referencedEnvVars(config: Config): string[] {
  const names = new Set<string>();
  for (const env of Object.values(config.environments)) {
    if (isEnvRef(env.baseUrl)) names.add(env.baseUrl.env);
    for (const role of Object.values(env.roles)) {
      if (isEnvRef(role.username)) names.add(role.username.env);
      names.add(role.password.env);
    }
  }
  return [...names].sort();
}
