import { referencedEnvVars } from '../config/load.ts';
import type { Config } from '../config/schema.ts';

/** Variáveis cujo nome indica segredo, mesmo que a config não as referencie. */
const SECRET_NAME = /PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY|PRIVATE_?KEY|CREDENTIAL/i;

/** Valores mais curtos que isto não são redigidos por valor exato (geraria ruído). */
const MIN_REDACTABLE_LENGTH = 4;

export class SecretError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretError';
  }
}

/**
 * Acesso controlado a segredos. O Claude só vê referências (`secret:NOME`);
 * o valor é resolvido aqui, dentro do servidor, e nunca devolvido ao modelo.
 */
export class SecretStore {
  private readonly allowed: Set<string>;

  constructor(
    allowedNames: Iterable<string>,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {
    this.allowed = new Set(allowedNames);
    for (const name of Object.keys(env)) if (SECRET_NAME.test(name)) this.allowed.add(name);
  }

  /** Passa a aceitar novas referências (ex.: ambiente cadastrado após config_reload). */
  allow(names: Iterable<string>): void {
    for (const n of names) this.allowed.add(n);
    for (const name of Object.keys(this.env)) if (SECRET_NAME.test(name)) this.allowed.add(name);
  }

  static fromConfig(config: Config, env: NodeJS.ProcessEnv = process.env): SecretStore {
    return new SecretStore(referencedEnvVars(config), env);
  }

  /** Resolve `secret:NOME`. Mensagens de erro citam só o nome, nunca o valor. */
  resolve(ref: string): string {
    const match = /^secret:([A-Z_][A-Z0-9_]*)$/.exec(ref);
    if (!match) throw new SecretError(`referência inválida "${ref}" (esperado secret:NOME)`);
    const name = match[1]!;
    if (!this.allowed.has(name)) throw new SecretError(`${name} não é uma variável de segredo permitida`);
    const value = this.env[name];
    if (value === undefined || value === '') throw new SecretError(`${name} não está definida no .env`);
    return value;
  }

  missing(names: Iterable<string>): string[] {
    return [...names].filter((n) => !this.env[n]);
  }

  /** Pares nome/valor para o Redactor. Inclui só segredos (não URLs nem usernames). */
  valuesForRedaction(): { name: string; value: string }[] {
    const out: { name: string; value: string }[] = [];
    for (const name of this.allowed) {
      const value = this.env[name];
      if (!value || value.length < MIN_REDACTABLE_LENGTH) continue;
      if (SECRET_NAME.test(name)) out.push({ name, value });
    }
    return out;
  }
}
