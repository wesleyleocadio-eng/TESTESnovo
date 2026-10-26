import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { Db } from '../state/db.ts';

/**
 * Digests: o resumo compacto que o Claude produz ao ler uma fonte pelo Atlassian MCP.
 * O cache guarda o digest (não a resposta bruta), versionado pelo `updated`/`version`
 * da fonte. A fonte original continua sendo a verdade (ARCHITECTURE.md D6).
 */

const MAX_DIGEST_CHARS = 8000;
const line = (max: number) => z.string().min(1).max(max);

export const JiraDigest = z.strictObject({
  key: z.string().regex(/^[A-Z][A-Z0-9]+-\d+$/),
  title: line(300),
  type: line(50),
  status: line(80),
  priority: line(50).optional(),
  parent: z.strictObject({ key: z.string(), title: line(300).optional() }).optional(),
  components: z.array(line(100)),
  labels: z.array(line(100)),
  summary: line(1200).describe('o que muda e para quem, em poucas frases'),
  acceptanceCriteria: z.array(line(600)).describe('copiados literalmente do card'),
  businessRules: z.array(line(400)),
  roles: z.array(line(100)).describe('perfis/papéis envolvidos'),
  openQuestions: z.array(line(400)).describe('ambiguidades e lacunas do card'),
  links: z.array(z.strictObject({ key: z.string(), relation: line(80), title: line(300).optional(), status: line(80).optional() })),
  attachments: z.array(z.strictObject({ name: line(200), kind: z.enum(['image', 'document', 'video', 'other']), note: line(200).optional() })),
  figma: z.array(z.string().url()),
  confluence: z.array(z.strictObject({ ref: line(300), title: line(300).optional() })),
  comments: z.array(line(400)).max(10).describe('só o que muda entendimento: decisões, exceções, bugs relatados'),
  environmentHints: z.array(line(300)).describe('URLs, ambientes, usuários de teste citados (nunca senhas)'),
});
export type JiraDigest = z.infer<typeof JiraDigest>;

export const ConfluenceDigest = z.strictObject({
  id: line(50),
  title: line(300),
  space: line(100).optional(),
  summary: line(1500),
  rules: z.array(line(400)),
  permissions: z.array(line(400)),
  flows: z.array(line(400)),
  sections: z.array(line(200)).describe('títulos das seções, para saber o que reler na fonte'),
  related: z.array(line(300)),
});
export type ConfluenceDigest = z.infer<typeof ConfluenceDigest>;

export const SOURCES = { jira: JiraDigest, confluence: ConfluenceDigest } as const;
export type Source = keyof typeof SOURCES;

export class DigestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DigestError';
  }
}

export interface StoredDigest {
  source: Source;
  key: string;
  version: string;
  hash: string;
  storedAt: string;
  digest: unknown;
}

export type DigestLookup =
  | { hit: true; version: string; storedAt: string; digest: unknown }
  | { hit: false; stale: boolean; cachedVersion?: string };

export class DigestCache {
  constructor(
    private readonly db: Db,
    private readonly rootDir: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private path(source: Source, key: string): string {
    return join(this.rootDir, '.cache', source, `${key.replace(/[^\w.-]+/g, '_')}.json`);
  }

  /**
   * Sem `version`, devolve o que houver. Com `version`, só é hit se a fonte não mudou —
   * é a checagem barata (getJiraIssue com fields=["updated"]) que evita reler o card.
   */
  get(source: Source, key: string, version?: string, scope?: { runId?: string | null }): DigestLookup {
    const row = this.db
      .prepare('SELECT version, path FROM cache_entries WHERE source = ? AND key = ?')
      .get(source, key) as { version: string; path: string } | undefined;
    const log = (type: string) =>
      this.db.prepare('INSERT INTO events (run_id, scenario_id, type, payload, ts) VALUES (?, NULL, ?, ?, ?)')
        .run(scope?.runId ?? null, type, JSON.stringify({ source, key }), this.now().toISOString());

    if (!row || !existsSync(row.path)) {
      log('cache.miss');
      return { hit: false, stale: false };
    }
    if (version !== undefined && row.version !== version) {
      log('cache.stale');
      return { hit: false, stale: true, cachedVersion: row.version };
    }
    const stored = JSON.parse(readFileSync(row.path, 'utf8')) as StoredDigest;
    log('cache.hit');
    return { hit: true, version: stored.version, storedAt: stored.storedAt, digest: stored.digest };
  }

  put(source: Source, key: string, version: string, digest: unknown): StoredDigest {
    const parsed = SOURCES[source].safeParse(digest);
    if (!parsed.success) {
      const problems = parsed.error.issues.map((i) => `${i.path.join('.') || '(raiz)'}: ${i.message}`);
      throw new DigestError(`digest ${source} inválido:\n- ${problems.join('\n- ')}`);
    }
    const ownKey = source === 'jira' ? (parsed.data as JiraDigest).key : (parsed.data as ConfluenceDigest).id;
    if (ownKey !== key) throw new DigestError(`digest é de ${ownKey}, não de ${key}`);
    const json = JSON.stringify(parsed.data);
    if (json.length > MAX_DIGEST_CHARS) {
      throw new DigestError(`digest com ${json.length} caracteres; o limite é ${MAX_DIGEST_CHARS} — compacte mais (a fonte continua disponível)`);
    }

    const stored: StoredDigest = {
      source, key, version,
      hash: createHash('sha256').update(json).digest('hex').slice(0, 16),
      storedAt: this.now().toISOString(),
      digest: parsed.data,
    };
    const path = this.path(source, key);
    mkdirSync(join(this.rootDir, '.cache', source), { recursive: true });
    writeFileSync(path, `${JSON.stringify(stored, null, 2)}\n`);
    this.db
      .prepare(
        `INSERT INTO cache_entries (source, key, version, hash, path, fetched_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (source, key) DO UPDATE SET version = excluded.version, hash = excluded.hash, path = excluded.path, fetched_at = excluded.fetched_at`,
      )
      .run(source, key, version, stored.hash, path, stored.storedAt);
    return stored;
  }

  /** Versão em cache, sem contar como hit/miss (usada para detectar resumos de conhecimento desatualizados). */
  cachedVersion(source: Source, key: string): string | undefined {
    const row = this.db.prepare('SELECT version FROM cache_entries WHERE source = ? AND key = ?').get(source, key) as { version: string } | undefined;
    return row?.version;
  }
}
