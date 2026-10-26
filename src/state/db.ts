import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { loadSqlite } from './sqlite.ts';

export type Db = DatabaseSync;

/**
 * Migrações em ordem. Nunca edite uma migração já aplicada: acrescente outra.
 * A versão aplicada fica em PRAGMA user_version.
 */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE runs (
    id                TEXT PRIMARY KEY,
    issue_key         TEXT NOT NULL,
    project           TEXT NOT NULL,
    env               TEXT NOT NULL,
    mode              TEXT NOT NULL CHECK (mode IN ('manual','explore','automate','retest')),
    parent_run_id     TEXT REFERENCES runs(id),
    status            TEXT NOT NULL CHECK (status IN ('PLANNING','AWAITING_APPROVAL','EXECUTING','COMPLETED','ABORTED')),
    plan_approved_at  TEXT,
    current_scenario  TEXT,
    recommendation    TEXT,
    summary           TEXT,
    started_at        TEXT NOT NULL,
    ended_at          TEXT
  );
  CREATE INDEX runs_issue ON runs(issue_key, started_at);

  CREATE TABLE scenarios (
    id                     INTEGER PRIMARY KEY,
    run_id                 TEXT NOT NULL REFERENCES runs(id),
    code                   TEXT NOT NULL,
    title                  TEXT NOT NULL,
    priority               TEXT NOT NULL CHECK (priority IN ('P0','P1','P2','P3')),
    types                  TEXT NOT NULL DEFAULT '[]',
    risk                   TEXT NOT NULL CHECK (risk IN ('HIGH','MEDIUM','LOW')),
    origin                 TEXT NOT NULL CHECK (origin IN ('planned','exploratory','retest')),
    parent_code            TEXT,
    preconditions          TEXT,
    steps                  TEXT NOT NULL DEFAULT '[]',
    expected               TEXT NOT NULL,
    status                 TEXT NOT NULL DEFAULT 'PENDING',
    confidence             TEXT,
    confidence_score       REAL,
    classification         TEXT,
    observed               TEXT,
    reason                 TEXT,
    automation_suitability TEXT,
    automation_approved    INTEGER NOT NULL DEFAULT 0,
    seq                    INTEGER NOT NULL,
    started_at             TEXT,
    ended_at               TEXT,
    UNIQUE (run_id, code)
  );

  CREATE TABLE actions (
    id           INTEGER PRIMARY KEY,
    run_id       TEXT NOT NULL REFERENCES runs(id),
    scenario_id  INTEGER REFERENCES scenarios(id),
    seq          INTEGER NOT NULL,
    action       TEXT NOT NULL,
    target_json  TEXT,
    value_ref    TEXT,
    guard_level  TEXT NOT NULL CHECK (guard_level IN ('GREEN','YELLOW','RED')),
    ok           INTEGER NOT NULL,
    error        TEXT,
    url          TEXT,
    duration_ms  INTEGER,
    ts           TEXT NOT NULL
  );

  CREATE TABLE evidence (
    id           INTEGER PRIMARY KEY,
    run_id       TEXT NOT NULL REFERENCES runs(id),
    scenario_id  INTEGER REFERENCES scenarios(id),
    kind         TEXT NOT NULL,
    path         TEXT,
    sha256       TEXT,
    sanitized    INTEGER NOT NULL,
    meta         TEXT,
    ts           TEXT NOT NULL
  );

  CREATE TABLE verifications (
    id           INTEGER PRIMARY KEY,
    run_id       TEXT NOT NULL REFERENCES runs(id),
    scenario_id  INTEGER NOT NULL REFERENCES scenarios(id),
    kind         TEXT NOT NULL CHECK (kind IN ('ui','url','network','api','persistence','console')),
    description  TEXT NOT NULL,
    expected     TEXT,
    actual       TEXT,
    passed       INTEGER NOT NULL,
    evidence_id  INTEGER REFERENCES evidence(id),
    ts           TEXT NOT NULL
  );

  CREATE TABLE findings (
    id              INTEGER PRIMARY KEY,
    run_id          TEXT NOT NULL REFERENCES runs(id),
    scenario_id     INTEGER REFERENCES scenarios(id),
    classification  TEXT NOT NULL,
    severity        TEXT,
    title           TEXT NOT NULL,
    repro           TEXT,
    status          TEXT NOT NULL,
    jira_key        TEXT,
    ts              TEXT NOT NULL
  );

  CREATE TABLE created_data (
    id              INTEGER PRIMARY KEY,
    run_id          TEXT NOT NULL REFERENCES runs(id),
    scenario_id     INTEGER REFERENCES scenarios(id),
    resource        TEXT NOT NULL,
    ext_id          TEXT,
    cleanup_json    TEXT,
    cleanup_status  TEXT NOT NULL DEFAULT 'PENDING',
    verified_at     TEXT,
    ts              TEXT NOT NULL
  );

  CREATE TABLE approvals (
    id        INTEGER PRIMARY KEY,
    run_id    TEXT NOT NULL REFERENCES runs(id),
    action    TEXT NOT NULL,
    target    TEXT,
    level     TEXT NOT NULL,
    decision  TEXT NOT NULL,
    ts        TEXT NOT NULL
  );

  CREATE TABLE events (
    id           INTEGER PRIMARY KEY,
    run_id       TEXT,
    scenario_id  INTEGER,
    type         TEXT NOT NULL,
    payload      TEXT,
    ts           TEXT NOT NULL
  );
  CREATE INDEX events_scope ON events(run_id, scenario_id, type);

  CREATE TABLE model_usage (
    id           INTEGER PRIMARY KEY,
    session_id   TEXT NOT NULL,
    agent        TEXT,
    run_id       TEXT,
    scenario_id  INTEGER,
    input        INTEGER NOT NULL,
    output       INTEGER NOT NULL,
    cache_read   INTEGER NOT NULL DEFAULT 0,
    cache_write  INTEGER NOT NULL DEFAULT 0,
    ts           TEXT NOT NULL
  );

  CREATE TABLE cache_entries (
    source      TEXT NOT NULL,
    key         TEXT NOT NULL,
    version     TEXT NOT NULL,
    hash        TEXT,
    path        TEXT NOT NULL,
    fetched_at  TEXT NOT NULL,
    PRIMARY KEY (source, key)
  );
  `,
  // 2: módulos de conhecimento do run (carregar/gravar execution knowledge do módulo certo).
  `ALTER TABLE runs ADD COLUMN modules TEXT NOT NULL DEFAULT '[]';`,
  // 3: uso de modelo vindo dos transcripts do Claude Code (uma linha por chamada ao modelo).
  `
  ALTER TABLE model_usage ADD COLUMN message_id TEXT;
  ALTER TABLE model_usage ADD COLUMN model TEXT;
  ALTER TABLE model_usage ADD COLUMN tools TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE model_usage ADD COLUMN sidechain INTEGER NOT NULL DEFAULT 0;
  CREATE UNIQUE INDEX model_usage_message ON model_usage(message_id);
  CREATE INDEX model_usage_ts ON model_usage(session_id, ts);
  `,
  // 4: automação — amostra de valor literal (nunca segredo) e execuções da suíte gerada.
  `
  ALTER TABLE actions ADD COLUMN value_sample TEXT;
  ALTER TABLE verifications ADD COLUMN spec_json TEXT;
  CREATE TABLE automation_runs (
    id           INTEGER PRIMARY KEY,
    issue_key    TEXT NOT NULL,
    project      TEXT NOT NULL,
    run_id       TEXT,
    kind         TEXT NOT NULL CHECK (kind IN ('attempt','validation')),
    started_at   TEXT NOT NULL,
    ended_at     TEXT,
    total        INTEGER NOT NULL DEFAULT 0,
    passed       INTEGER NOT NULL DEFAULT 0,
    failed       INTEGER NOT NULL DEFAULT 0,
    flaky        INTEGER NOT NULL DEFAULT 0,
    skipped      INTEGER NOT NULL DEFAULT 0,
    exit_code    INTEGER,
    report_path  TEXT
  );
  CREATE TABLE automation_tests (
    id                 INTEGER PRIMARY KEY,
    automation_run_id  INTEGER NOT NULL REFERENCES automation_runs(id),
    file               TEXT NOT NULL,
    title              TEXT NOT NULL,
    scenario_code      TEXT,
    status             TEXT NOT NULL CHECK (status IN ('passed','failed','flaky','skipped')),
    attempts           INTEGER NOT NULL,
    duration_ms        INTEGER,
    error              TEXT
  );
  `,
];

export function openDb(path: string): Db {
  const { DatabaseSync } = loadSqlite();
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

function migrate(db: Db): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  for (let v = row.user_version; v < MIGRATIONS.length; v++) {
    transaction(db, () => {
      db.exec(MIGRATIONS[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    });
  }
}

export function transaction<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
