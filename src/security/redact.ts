/**
 * Sanitização de tudo que sai do servidor: respostas de ferramenta, logs,
 * evidências e relatórios. Na dúvida, redige — segurança vem antes de detalhe.
 */

export const REDACTED = '[REDACTED]';

const DEFAULT_SENSITIVE_KEYS = [
  'password', 'passwd', 'pwd', 'senha', 'secret', 'token', 'apikey', 'api_key', 'api-key',
  'authorization', 'cookie', 'cvv', 'cvc', 'cardnumber', 'card_number', 'privatekey',
  'private_key', 'credential', 'sessionid', 'session_id',
];

/** Chaves usadas no padrão `chave=valor` / `"chave": "valor"` dentro de texto livre. */
const TEXT_KEY_PATTERN =
  'password|passwd|pwd|senha|secret|token|api[_-]?key|apikey|cvv|cvc|card[_-]?number|private[_-]?key|session[_-]?id';

const JWT = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g;
const AUTH_SCHEME = /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const HEADER_LINE = /^(\s*(?:cookie|set-cookie|authorization|proxy-authorization|x-api-key|x-auth-token)\s*:\s*).+$/gim;
const KEY_VALUE = new RegExp(
  `((["']?)[\\w.-]*(?:${TEXT_KEY_PATTERN})[\\w.-]*\\2\\s*[:=]\\s*)("(?:[^"\\\\]|\\\\.)*"|'[^']*'|[^\\s&,;}"']+)`,
  'gi',
);
// Candidatos a cartão no formato em que cartões aparecem: 15–16 dígitos contínuos,
// 4-4-4-4(-3) com o mesmo separador, ou Amex 4-6-5. Sequências arbitrárias de dígitos com
// hífen (datas, timestamps, ids compostos) não entram — evita corromper ids nas respostas.
const CARD_CANDIDATE = /\b(?:\d{15,16}|\d{4}([ -])\d{4}\1\d{4}\1\d{4}(?:\1\d{3})?|3[47]\d{2}([ -])\d{6}\2\d{5})\b/g;

function luhnValid(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

function looksLikeCard(candidate: string): boolean {
  const digits = candidate.replace(/[ -]/g, '');
  if (digits.length < 15 || digits.length > 19) return false;
  // Bandeiras começam com 2–6. Exclui epoch em ms (começa com 1) e ids com zero à esquerda.
  if (!/^[2-6]/.test(digits)) return false;
  if (/^(\d)\1+$/.test(digits)) return false;
  return luhnValid(digits);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface RedactorOptions {
  /** Valores exatos a redigir (ex.: senhas do .env). */
  secrets?: { name: string; value: string }[];
  /** Chaves sensíveis extras (qa-policy.yaml → redaction.extraSensitiveKeys). */
  extraSensitiveKeys?: string[];
}

export class Redactor {
  private exact: { pattern: RegExp; label: string }[] = [];
  private sensitiveKeys: string[] = [];

  constructor(options: RedactorOptions = {}) {
    this.configure(options);
  }

  /** Reconfigura em memória (ex.: senha nova no .env após config_reload), preservando a referência. */
  configure(options: RedactorOptions): void {
    // Segredos com o mesmo valor (ex.: dois papéis com a mesma senha) viram um rótulo só com todos os nomes,
    // para o rótulo não sugerir que um papel está usando o segredo do outro.
    const byValue = new Map<string, string[]>();
    for (const { name, value } of options.secrets ?? []) byValue.set(value, [...(byValue.get(value) ?? []), name]);
    const secrets = [...byValue].map(([value, names]) => ({ value, name: [...new Set(names)].sort().join('|') }))
      .sort((a, b) => b.value.length - a.value.length);
    this.exact = secrets.flatMap(({ name, value }) => {
      // Também as formas codificadas em URL e escapadas em JSON, como aparecem em network/logs.
      const variants = new Set([value, encodeURIComponent(value), JSON.stringify(value).slice(1, -1)]);
      return [...variants].map((v) => ({ pattern: new RegExp(escapeRegExp(v), 'g'), label: `[REDACTED:${name}]` }));
    });
    this.sensitiveKeys = [...DEFAULT_SENSITIVE_KEYS, ...(options.extraSensitiveKeys ?? []).map((k) => k.toLowerCase())];
  }

  isSensitiveKey(key: string): boolean {
    const k = key.toLowerCase();
    return this.sensitiveKeys.some((s) => k.includes(s));
  }

  text(input: string): string {
    let out = input;
    for (const { pattern, label } of this.exact) out = out.replace(pattern, label);
    out = out.replace(HEADER_LINE, `$1${REDACTED}`);
    out = out.replace(AUTH_SCHEME, `$1 ${REDACTED}`);
    out = out.replace(JWT, REDACTED);
    out = out.replace(KEY_VALUE, (match, prefix: string, _q: string, value: string) => {
      if (/^["']?\[REDACTED/.test(value)) return match; // já redigido (mantém o rótulo com o nome)
      // Prosa ("senha: requisitos de segurança"): palavra comum sem aspas não é segredo.
      // Segredos conhecidos já foram trocados pelo valor exato acima.
      if (/^\p{Ll}+$/u.test(value)) return match;
      const quote = value.startsWith('"') ? '"' : value.startsWith("'") ? "'" : '';
      return `${prefix}${quote}${REDACTED}${quote}`;
    });
    out = out.replace(CARD_CANDIDATE, (m) => (looksLikeCard(m) ? '[REDACTED:CARD]' : m));
    return out;
  }

  /** Redação profunda de objetos/arrays: chave sensível → valor redigido; strings → text(). */
  value<T>(input: T): T {
    return this.walk(input) as T;
  }

  headers(headers: Record<string, string>): Record<string, string> {
    return this.value(headers);
  }

  private walk(input: unknown): unknown {
    if (typeof input === 'string') return this.text(input);
    if (Array.isArray(input)) return input.map((v) => this.walk(v));
    if (input && typeof input === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(input)) {
        out[k] = this.isSensitiveKey(k) && v !== null && v !== undefined && v !== '' ? REDACTED : this.walk(v);
      }
      return out;
    }
    return input;
  }
}
