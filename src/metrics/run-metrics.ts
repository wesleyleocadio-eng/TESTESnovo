import type { Db } from '../state/db.ts';
import type { StateStore } from '../state/store.ts';

/**
 * Métricas de um run (ARCHITECTURE.md §6). Atribuição por janela de tempo:
 * - run: da descoberta do card (context_build/digest) até o fim do run;
 * - sessões: só as que chamaram ferramentas novo-qa dentro da janela (exclui sessões paralelas);
 * - cenário: de scenario_start a scenario_complete.
 * "fresh" = entrada nova + escrita de cache + saída; leitura de cache é reportada à parte.
 */

const DISCOVERY_LOOKBACK_MS = 12 * 60 * 60 * 1000;

interface UsageRow { session_id: string; sidechain: number; input: number; output: number; cache_read: number; cache_write: number; ts: string }

function sum(rows: UsageRow[]) {
  const t = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  for (const r of rows) {
    t.input += r.input;
    t.cacheRead += r.cache_read;
    t.cacheWrite += r.cache_write;
    t.output += r.output;
  }
  return { ...t, fresh: t.input + t.cacheWrite + t.output };
}

const minutesBetween = (a: string, b: string) => Math.round(((Date.parse(b) - Date.parse(a)) / 60000) * 10) / 10;

export function computeRunMetrics(db: Db, store: StateStore, runId: string, now: () => Date = () => new Date()) {
  const run = store.getRun(runId);
  // A descoberta deste run não começa antes do fim do run anterior do mesmo card.
  const previous = db
    .prepare('SELECT MAX(COALESCE(ended_at, started_at)) AS ts FROM runs WHERE issue_key = ? AND started_at < ? AND id <> ?')
    .get(run.issue_key, run.started_at, run.id) as { ts: string | null };
  const twelveHours = new Date(Date.parse(run.started_at) - DISCOVERY_LOOKBACK_MS).toISOString();
  const lookback = previous.ts && previous.ts > twelveHours ? previous.ts : twelveHours;
  const discovery = db
    .prepare(
      `SELECT MIN(ts) AS ts FROM events
       WHERE ts > ? AND ts <= ? AND (
         (type = 'context.build' AND payload LIKE ?) OR (type LIKE 'cache.%' AND payload LIKE ?))`,
    )
    .get(lookback, run.started_at, `%"issueKey":"${run.issue_key}"%`, `%"key":"${run.issue_key}"%`) as { ts: string | null };
  const start = discovery.ts && discovery.ts < run.started_at ? discovery.ts : run.started_at;
  const lastEvent = db.prepare('SELECT MAX(ts) AS ts FROM events WHERE run_id = ?').get(runId) as { ts: string | null };
  const end = run.ended_at ?? lastEvent.ts ?? now().toISOString();

  const sessions = (db
    .prepare(`SELECT DISTINCT session_id FROM model_usage WHERE ts BETWEEN ? AND ? AND tools LIKE '%mcp__novo-qa__%'`)
    .all(start, end) as { session_id: string }[]).map((r) => r.session_id);
  const usage = sessions.length
    ? (db
        .prepare(`SELECT session_id, sidechain, input, output, cache_read, cache_write, ts FROM model_usage
                  WHERE ts BETWEEN ? AND ? AND session_id IN (${sessions.map(() => '?').join(',')}) ORDER BY ts`)
        .all(start, end, ...sessions) as unknown as UsageRow[])
    : [];
  const tokens = sum(usage);

  const scenarios = store.scenarioDetails(runId);
  const timing = db.prepare('SELECT started_at, ended_at FROM scenarios WHERE id = ?');
  const perScenario = scenarios.flatMap((s) => {
    const t = timing.get(s.id) as { started_at: string | null; ended_at: string | null };
    if (!t.started_at || !t.ended_at) return [];
    const rows = usage.filter((u) => u.ts >= t.started_at! && u.ts <= t.ended_at!);
    return [{ code: s.code, status: s.status, minutes: minutesBetween(t.started_at, t.ended_at), calls: rows.length, fresh: sum(rows).fresh }];
  });

  const count = (sql: string, ...p: string[]) => Number((db.prepare(sql).get(...p) as { n: number }).n);
  const verifications = count('SELECT COUNT(*) AS n FROM verifications WHERE run_id = ?', runId);
  const finished = scenarios.filter((s) => !['PENDING', 'IN_PROGRESS'].includes(s.status)).length;
  const exploratory = scenarios.filter((s) => s.origin === 'exploratory').length;
  const decisions = finished + verifications + exploratory;
  const bugs = scenarios.filter((s) => s.status === 'FAILED' && s.classification === 'PRODUCT_BUG').length;

  const cache = (type: string) => count(`SELECT COUNT(*) AS n FROM events WHERE type = ? AND ts BETWEEN ? AND ?`, type, start, end);
  const hits = cache('cache.hit');
  const misses = cache('cache.miss');
  const stale = cache('cache.stale');
  const lookups = hits + misses + stale;

  const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
  return {
    window: { start, end, minutes: minutesBetween(start, end) },
    model: {
      sessions: sessions.length,
      calls: usage.length,
      subagentCalls: usage.filter((u) => u.sidechain).length,
      tokens,
    },
    perScenario: {
      avgFresh: avg(perScenario.map((p) => p.fresh)),
      avgMinutes: perScenario.length ? Math.round((perScenario.reduce((a, p) => a + p.minutes, 0) / perScenario.length) * 10) / 10 : null,
      costliest: [...perScenario].sort((a, b) => b.fresh - a.fresh).slice(0, 5),
    },
    perBug: bugs ? Math.round(tokens.fresh / bugs) : null,
    perDecision: decisions ? Math.round(tokens.fresh / decisions) : null,
    decisions: { total: decisions, scenariosFinished: finished, verifications, exploratory },
    bugs,
    cache: { hits, misses, stale, hitRate: lookups ? Math.round((hits / lookups) * 100) / 100 : null },
    deterministic: {
      toolCalls: count(`SELECT COUNT(*) AS n FROM events WHERE run_id = ? AND type LIKE 'tool.%'`, runId),
      browserActions: count('SELECT COUNT(*) AS n FROM actions WHERE run_id = ?', runId),
      screenshots: count(`SELECT COUNT(*) AS n FROM evidence WHERE run_id = ? AND kind = 'screenshot'`, runId),
    },
    automation: automationMetrics(db, runId),
  };
}

function automationMetrics(db: Db, runId: string) {
  const runs = db.prepare(`SELECT kind, total, passed, flaky FROM automation_runs WHERE run_id = ? ORDER BY id`).all(runId) as { kind: string; total: number; passed: number; flaky: number }[];
  if (runs.length === 0) return null;
  const last = [...runs].reverse().find((r) => r.kind === 'validation') ?? runs.at(-1)!;
  const delivered = (db.prepare(`SELECT COUNT(*) AS n FROM events WHERE run_id = ? AND type = 'automation.validated'`).get(runId) as { n: number }).n > 0;
  return {
    attempts: runs.filter((r) => r.kind === 'attempt').length,
    validations: runs.filter((r) => r.kind === 'validation').length,
    basis: last.kind as 'attempt' | 'validation',
    total: last.total,
    passed: last.passed,
    successRate: last.total ? Math.round((last.passed / last.total) * 100) / 100 : null,
    flakyRate: last.total ? Math.round((last.flaky / last.total) * 100) / 100 : null,
    delivered,
  };
}

export type RunMetrics = ReturnType<typeof computeRunMetrics>;

const k = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : String(n));

export function formatMetrics(m: RunMetrics): string[] {
  const t = m.model.tokens;
  const lines = [
    `Uso do modelo: ${k(t.fresh)} tokens novos (entrada ${k(t.input)} · escrita cache ${k(t.cacheWrite)} · saída ${k(t.output)}) + ${k(t.cacheRead)} lidos do cache`,
    `Chamadas ao modelo: ${m.model.calls} (${m.model.subagentCalls} em subagente) em ${m.model.sessions} sessão(ões) · ${m.window.minutes} min`,
    `Por cenário: ${m.perScenario.avgFresh ?? '—'} tokens novos · ${m.perScenario.avgMinutes ?? '—'} min · por decisão útil: ${m.perDecision ?? '—'}${m.perBug !== null ? ` · por bug: ${k(m.perBug)}` : ''}`,
    `Decisões úteis: ${m.decisions.total} (${m.decisions.scenariosFinished} cenários, ${m.decisions.verifications} verificações, ${m.decisions.exploratory} exploratórios)`,
    `Cache de contexto: ${m.cache.hits}/${m.cache.hits + m.cache.misses + m.cache.stale} hit${m.cache.hitRate !== null ? ` (${Math.round(m.cache.hitRate * 100)}%)` : ''}`,
    `Determinístico: ${m.deterministic.toolCalls} chamadas de ferramenta · ${m.deterministic.browserActions} ações no navegador · ${m.deterministic.screenshots} screenshots`,
  ];
  if (m.automation) {
    const a = m.automation;
    lines.push(`Automação: ${a.passed}/${a.total} passaram (${a.basis === 'validation' ? 'validação' : 'última tentativa'}) · flaky ${Math.round((a.flakyRate ?? 0) * 100)}% · ${a.attempts} tentativa(s) · ${a.delivered ? 'entregue' : 'não entregue'}`);
  }
  if (m.model.calls === 0) lines.push('(sem uso de modelo atribuído: transcripts não encontrados ou run executado fora do Claude Code)');
  return lines;
}
