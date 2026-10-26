import { resolveValue } from '../config/load.ts';
import type { Environment } from '../config/schema.ts';
import { SecretError, type SecretStore } from '../security/secrets.ts';

export interface ResolvedValue {
  value: string;
  /** Tipo do dado registrado no execution knowledge (nunca o valor). */
  valueType: string;
  sensitive: boolean;
}

/**
 * Resolve uma referência de valor dentro do servidor:
 *   secret:NOME              → variável de segredo do .env
 *   role:<papel>.username    → usuário do papel no ambiente do run
 *   role:<papel>.password    → senha do papel (sempre via .env)
 */
export function resolveValueRef(ref: string, env: Environment, secrets: SecretStore): ResolvedValue {
  if (ref.startsWith('secret:')) return { value: secrets.resolve(ref), valueType: 'secret', sensitive: true };

  const match = /^role:([a-z0-9-]+)\.(username|password)$/.exec(ref);
  if (!match) throw new SecretError(`valueRef inválido "${ref}" (use secret:NOME ou role:<papel>.username|password)`);
  const [, roleName, field] = match as unknown as [string, string, 'username' | 'password'];
  const role = env.roles[roleName];
  if (!role) throw new SecretError(`papel "${roleName}" não existe no ambiente (papéis: ${Object.keys(env.roles).join(', ')})`);

  if (field === 'password') {
    return { value: secrets.resolve(`secret:${role.password.env}`), valueType: 'password', sensitive: true };
  }
  const username = resolveValue(role.username);
  if (!username) throw new SecretError(`usuário do papel "${roleName}" não está definido no .env`);
  return { value: username, valueType: 'username', sensitive: false };
}
