import type { Config } from '../config/schema.ts';
import { OPEN_CLEANUP, type CleanupSpec, type CleanupStatus, type CreatedDataRow } from './cleanup.ts';
import { transaction, type Db } from './db.ts';
import {
  evaluateCompletion,
  FINAL_STATUSES,
  type Classification,
  type CompletionFacts,
  type CompletionRequest,
  type FinalStatus,
  type ScenarioStatus,
  type VerificationKind,
} from './rules.ts';

export class StateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StateError';
  }
}

export type RunMode = 'manual' | 'explore' | 'automate' | 'retest';
export type RunStatus = 'PLANNING' | 'AWAITING_APPROVAL' | 'EXECUTING' | 'COMPLETED' | 'ABORTED';
export type Priority = 'P0' | 'P1' | 'P2' | 'P3';
export type Risk = 'HIGH' | 'MEDIUM' | 'LOW';

export interface RunRow {
  id: string;
  issue_key: string;
  project: string;
  env: string;
  mode: RunMode;
  parent_run_id: string | null;
  status: RunStatus;
  plan_approved_at: string | null;
  current_scenario: string | null;
  recommendation: string | null;
  summary: string | null;
  started_at: string;
  ended_at: string | null;
  /** JSON: módulos de conhecimento do run. */
  modules: string;
}

export interface ScenarioDetails extends ScenarioRow {
  types: string[];
  origin: string;
  parent_code: string | null;
  preconditions: string | null;
  steps: string[];
  expected: string;
  classification: string | null;
  confidence: string | null;
  observed: string | null;
  reason: string | null;
}

export interface ScenarioRow {
  id: number;
  run_id: string;
  code: string;
  title: string;
  priority: Priority;
  risk: Risk;
  status: ScenarioStatus;
  seq: number;
}

export interface ScenarioInput {
  code: string;
  title: string;
  priority: Priority;
  risk: Risk;
  types: string[];
  preconditions?: string;
  steps: string[];
  expected: string;
}

export interface ValidatedActionRow {
  action: string;
  target_json: string | null;
  value_ref: string | null;
  url: string | null;
  ts: string;
  scenario: string;
}

export type ExploratoryInput = Omit<ScenarioInput, 'code'> & { parentCode?: string };

const ACTIVE_RUN: RunStatus[] = ['PLANNING', 'AWAITING_APPROVAL', 'EXECUTING'];
const PLAN_CODE = /^CT-\d{2,4}$/;

export interface StoreOptions {
  now?: () => Date;
}

export class StateStore {
  private readonly now: () => Date;

  constructor(
    private readonly db: Db,
    private readonly config: Config,
    options: StoreOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  private ts(): string {
    return this.now().toISOString();
  }

  // ── Runs ────────────────────────────────────────────────────────────

  startRun(input: { issueKey: string; env: string; mode: RunMode; parentRunId?: string }): RunRow {
    const env = this.config.environments[input.env];
    if (!env) throw new StateError(`ambiente "${input.env}" não existe em config/environments.yaml`);
    const project = this.config.projects[env.project]!;
    const prefix = input.issueKey.split('-')[0]!;
    if (project.jiraKeys.length > 0 && !project.jiraKeys.includes(prefix)) {
      throw new StateError(`${input.issueKey} não pertence ao projeto ${env.project} (chaves: ${project.jiraKeys.join(', ')})`);
    }

    const active = this.db
      .prepare(`SELECT id FROM runs WHERE issue_key = ? AND status IN (${ACTIVE_RUN.map(() => '?').join(',')})`)
      .get(input.issueKey, ...ACTIVE_RUN) as { id: string } | undefined;
    if (active) throw new StateError(`já existe run ativo ${active.id} para ${input.issueKey} — use /resume ou aborte-o`);

    if (input.mode === 'retest') {
      if (!input.parentRunId) throw new StateError('retest exige parentRunId');
      const parent = this.getRun(input.parentRunId);
      if (parent.issue_key !== input.issueKey || parent.status !== 'COMPLETED') {
        throw new StateError(`run pai ${parent.id} precisa ser do mesmo card e estar COMPLETED`);
      }
    }

    const started = this.ts();
    // 20261023T100000: o "T" impede que data+hora formem uma sequência longa de dígitos.
    const stamp = started.replace(/[-:]/g, '').slice(0, 15);
    let id = `${input.issueKey}-${stamp}`;
    for (let n = 2; this.db.prepare('SELECT 1 FROM runs WHERE id = ?').get(id); n++) id = `${input.issueKey}-${stamp}-${n}`;

    this.db
      .prepare(
        `INSERT INTO runs (id, issue_key, project, env, mode, parent_run_id, status, started_at)
         VALUES (?, ?, ?, ?, ?, ?, 'PLANNING', ?)`,
      )
      .run(id, input.issueKey, env.project, input.env, input.mode, input.parentRunId ?? null, started);
    this.logEvent(id, null, 'run.start', { mode: input.mode, env: input.env });
    return this.getRun(id);
  }

  getRun(id: string): RunRow {
    const run = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as RunRow | undefined;
    if (!run) throw new StateError(`run ${id} não existe`);
    return run;
  }

  /** Aceita id de run ou chave do card (usa o run mais recente). */
  resolveRun(idOrKey: string): RunRow {
    const byId = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(idOrKey) as RunRow | undefined;
    if (byId) return byId;
    const latest = this.db
      .prepare('SELECT * FROM runs WHERE issue_key = ? ORDER BY started_at DESC, rowid DESC LIMIT 1')
      .get(idOrKey) as RunRow | undefined;
    if (!latest) throw new StateError(`nenhum run para ${idOrKey}`);
    return latest;
  }

  runStatus(idOrKey: string) {
    const run = this.resolveRun(idOrKey);
    const scenarios = this.listScenarios(run.id);
    const counts: Record<string, number> = {};
    for (const s of scenarios) counts[s.status] = (counts[s.status] ?? 0) + 1;
    const done = scenarios.filter((s) => (FINAL_STATUSES as readonly string[]).includes(s.status)).length;
    const inProgress = scenarios.filter((s) => s.status === 'IN_PROGRESS').map((s) => s.code);
    const next = inProgress[0] ?? scenarios.find((s) => s.status === 'PENDING')?.code ?? null;
    return {
      run: { id: run.id, issue: run.issue_key, env: run.env, mode: run.mode, status: run.status },
      progress: `${done}/${scenarios.length}`,
      counts,
      inProgress,
      next,
    };
  }

  completeRun(runId: string, recommendation: 'APROVADO' | 'REPROVADO' | 'INCONCLUSIVO', summary: string): RunRow {
    const run = this.getRun(runId);
    if (run.status !== 'EXECUTING') throw new StateError(`run está ${run.status}; só runs EXECUTING podem ser concluídos`);
    const open = this.listScenarios(runId).filter((s) => s.status === 'PENDING' || s.status === 'IN_PROGRESS');
    if (open.length > 0) {
      throw new StateError(`cenários sem status final: ${open.map((s) => s.code).join(', ')} — conclua ou marque NOT_EXECUTED`);
    }
    const dirty = this.listCreatedData(runId).filter((d) => OPEN_CLEANUP.includes(d.cleanup_status));
    if (dirty.length > 0) {
      const list = dirty.map((d) => `#${d.id} ${d.resource}${d.ext_id ? ` (${d.ext_id})` : ''}: ${d.cleanup_status}`).join('; ');
      throw new StateError(`dados criados sem limpeza resolvida: ${list} — use data_register e cleanup_run (ou keep com motivo)`);
    }
    this.db
      .prepare(`UPDATE runs SET status = 'COMPLETED', recommendation = ?, summary = ?, current_scenario = NULL, ended_at = ? WHERE id = ?`)
      .run(recommendation, summary, this.ts(), runId);
    this.logEvent(runId, null, 'run.complete', { recommendation });
    return this.getRun(runId);
  }

  abortRun(runId: string, reason: string): RunRow {
    const run = this.getRun(runId);
    if (!ACTIVE_RUN.includes(run.status)) throw new StateError(`run já está ${run.status}`);
    this.db
      .prepare(`UPDATE runs SET status = 'ABORTED', summary = ?, ended_at = ? WHERE id = ?`)
      .run(reason, this.ts(), runId);
    this.logEvent(runId, null, 'run.abort', { reason });
    return this.getRun(runId);
  }

  // ── Plano ───────────────────────────────────────────────────────────

  /** Salva (ou substitui) o plano. Só antes da aprovação; depois disso, use cenários exploratórios. */
  savePlan(runId: string, scenarios: ScenarioInput[], modules: string[] = []): { count: number; status: RunStatus } {
    const run = this.getRun(runId);
    if (run.status !== 'PLANNING' && run.status !== 'AWAITING_APPROVAL') {
      throw new StateError(`plano não pode mudar com run ${run.status}; use scenario_add para exploratórios`);
    }
    if (scenarios.length === 0) throw new StateError('plano vazio');
    const codes = new Set<string>();
    for (const s of scenarios) {
      if (!PLAN_CODE.test(s.code)) throw new StateError(`código inválido "${s.code}" (esperado CT-001)`);
      if (codes.has(s.code)) throw new StateError(`código duplicado ${s.code}`);
      codes.add(s.code);
    }

    const origin = run.mode === 'retest' ? 'retest' : 'planned';
    transaction(this.db, () => {
      this.db.prepare('DELETE FROM scenarios WHERE run_id = ?').run(runId);
      const insert = this.db.prepare(
        `INSERT INTO scenarios (run_id, code, title, priority, types, risk, origin, preconditions, steps, expected, seq)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      scenarios.forEach((s, i) =>
        insert.run(runId, s.code, s.title, s.priority, JSON.stringify(s.types), s.risk, origin,
          s.preconditions ?? null, JSON.stringify(s.steps), s.expected, i + 1),
      );
      this.db.prepare(`UPDATE runs SET status = 'AWAITING_APPROVAL', modules = ? WHERE id = ?`).run(JSON.stringify(modules), runId);
    });
    this.logEvent(runId, null, 'plan.save', { count: scenarios.length });
    return { count: scenarios.length, status: 'AWAITING_APPROVAL' };
  }

  /** Chamado só pela ferramenta plan_approve, que exige aprovação humana no Claude Code. */
  approvePlan(runId: string): RunRow {
    const run = this.getRun(runId);
    if (run.status !== 'AWAITING_APPROVAL') throw new StateError(`run está ${run.status}; nada a aprovar`);
    const ts = this.ts();
    transaction(this.db, () => {
      this.db.prepare(`UPDATE runs SET status = 'EXECUTING', plan_approved_at = ? WHERE id = ?`).run(ts, runId);
      this.db
        .prepare(`INSERT INTO approvals (run_id, action, target, level, decision, ts) VALUES (?, 'plan', ?, 'PLAN', 'APPROVED', ?)`)
        .run(runId, run.issue_key, ts);
    });
    this.logEvent(runId, null, 'plan.approve', null);
    return this.getRun(runId);
  }

  // ── Cenários ────────────────────────────────────────────────────────

  listScenarios(runId: string): ScenarioRow[] {
    return this.db
      .prepare('SELECT id, run_id, code, title, priority, risk, status, seq FROM scenarios WHERE run_id = ? ORDER BY seq')
      .all(runId) as unknown as ScenarioRow[];
  }

  scenarioDetails(runId: string): ScenarioDetails[] {
    const rows = this.db.prepare('SELECT * FROM scenarios WHERE run_id = ? ORDER BY seq').all(runId) as unknown as (Omit<ScenarioDetails, 'types' | 'steps'> & { types: string; steps: string })[];
    return rows.map((r) => ({ ...r, types: JSON.parse(r.types) as string[], steps: JSON.parse(r.steps) as string[] }));
  }

  /**
   * Próximo lote para um test-executor (ARCHITECTURE.md D4): começa pelo cenário em andamento,
   * segue a ordem do plano e encolhe o lote quando entra cenário de risco maior.
   */
  nextBatch(runId: string, sizes: Record<Risk, number>): ScenarioDetails[] {
    const open = this.scenarioDetails(runId).filter((s) => s.status === 'IN_PROGRESS' || s.status === 'PENDING');
    open.sort((a, b) => (a.status === 'IN_PROGRESS' ? -1 : 0) - (b.status === 'IN_PROGRESS' ? -1 : 0) || a.seq - b.seq);
    const batch: ScenarioDetails[] = [];
    for (const s of open) {
      const limit = Math.min(...[...batch, s].map((x) => sizes[x.risk]));
      if (batch.length >= limit) break;
      batch.push(s);
    }
    return batch;
  }

  /** O que já foi feito num cenário (para retomar sem refazer): últimas verificações e nº de ações. */
  scenarioProgress(scenarioId: number): { verified: string[]; actions: number } {
    const since = this.attemptStart(scenarioId);
    const rows = this.db
      .prepare('SELECT kind, description, passed FROM verifications WHERE scenario_id = ? AND ts >= ? ORDER BY id')
      .all(scenarioId, since) as { kind: string; description: string; passed: number }[];
    const latest = new Map<string, string>();
    for (const r of rows) latest.set(`${r.kind}|${r.description}`, `${r.kind}: ${r.description} (${r.passed ? 'passou' : 'reprovou'})`);
    const actions = (this.db.prepare('SELECT COUNT(*) AS n FROM actions WHERE scenario_id = ? AND ts >= ? AND ok = 1').get(scenarioId, since) as { n: number }).n;
    return { verified: [...latest.values()], actions };
  }

  getScenario(runId: string, code: string): ScenarioRow {
    const s = this.db
      .prepare('SELECT id, run_id, code, title, priority, risk, status, seq FROM scenarios WHERE run_id = ? AND code = ?')
      .get(runId, code) as ScenarioRow | undefined;
    if (!s) throw new StateError(`cenário ${code} não existe no run ${runId}`);
    return s;
  }

  private requireExecuting(runId: string): RunRow {
    const run = this.getRun(runId);
    if (run.status === 'AWAITING_APPROVAL') throw new StateError('plano aguardando aprovação humana (plan_approve)');
    if (run.status !== 'EXECUTING') throw new StateError(`run está ${run.status}`);
    return run;
  }

  startScenario(runId: string, code: string): ScenarioRow & { resumed: boolean } {
    this.requireExecuting(runId);
    const s = this.getScenario(runId, code);
    if (s.status === 'IN_PROGRESS') return { ...s, resumed: true };
    if (s.status !== 'PENDING') throw new StateError(`${code} já está ${s.status}`);
    const other = this.listScenarios(runId).find((x) => x.status === 'IN_PROGRESS');
    if (other) throw new StateError(`conclua ${other.code} antes de iniciar ${code}`);

    const ts = this.ts();
    transaction(this.db, () => {
      this.db.prepare(`UPDATE scenarios SET status = 'IN_PROGRESS', started_at = ? WHERE id = ?`).run(ts, s.id);
      this.db.prepare('UPDATE runs SET current_scenario = ? WHERE id = ?').run(code, runId);
    });
    this.logEvent(runId, s.id, 'scenario.start', null);
    return { ...this.getScenario(runId, code), resumed: false };
  }

  /**
   * Reabre um cenário BLOCKED/NOT_EXECUTED/NEEDS_REVIEW no mesmo run (ex.: o ambiente voltou).
   * A tentativa anterior fica no histórico, mas deixa de contar: a próxima scenario_start abre
   * uma janela nova e só verificações/evidências dela valem para concluir. PASSED/FAILED não reabrem.
   */
  reopenScenario(runId: string, code: string, reason: string): ScenarioRow {
    this.requireExecuting(runId);
    const s = this.getScenario(runId, code);
    if (!['BLOCKED', 'NOT_EXECUTED', 'NEEDS_REVIEW'].includes(s.status)) {
      throw new StateError(`${code} está ${s.status}: só BLOCKED, NOT_EXECUTED ou NEEDS_REVIEW reabrem (resultado PASSED/FAILED vale; use /retest)`);
    }
    if (reason.trim().length < 10) throw new StateError('reopen exige motivo (o que mudou desde a tentativa anterior)');
    this.db
      .prepare(`UPDATE scenarios SET status = 'PENDING', classification = NULL, observed = NULL, reason = NULL, confidence = NULL, confidence_score = NULL, started_at = NULL, ended_at = NULL WHERE id = ?`)
      .run(s.id);
    this.logEvent(runId, s.id, 'scenario.reopen', { from: s.status, reason });
    return this.getScenario(runId, code);
  }

  /**
   * Corrige status/classificação de um resultado final (FAILED, NEEDS_REVIEW, BLOCKED) sem refazer
   * o cenário — ex.: o executor marcou PRODUCT_BUG o que é divergência de requisito. As regras de
   * conclusão valem de novo sobre as verificações da tentativa; a mudança fica registrada com o motivo.
   * Vale também com o run concluído (o relatório é regerado depois).
   */
  reclassifyScenario(runId: string, code: string, req: CompletionRequest, justification: string) {
    const run = this.getRun(runId);
    if (run.status !== 'EXECUTING' && run.status !== 'COMPLETED') throw new StateError(`run está ${run.status}`);
    const s = this.getScenario(runId, code);
    const allowed = ['FAILED', 'NEEDS_REVIEW', 'BLOCKED'];
    if (!allowed.includes(s.status) || !allowed.includes(req.status)) {
      throw new StateError(`reclassificação só entre ${allowed.join('/')} (${code} está ${s.status}; pedido: ${req.status})`);
    }
    if (justification.trim().length < 15) throw new StateError('reclassificação exige justificativa (por que a classificação anterior estava errada)');
    const before = this.db.prepare('SELECT status, classification FROM scenarios WHERE id = ?').get(s.id) as { status: string; classification: string | null };
    const result = evaluateCompletion(req, { ...this.completionFacts(s), currentStatus: 'IN_PROGRESS' });
    if (!result.ok) throw new StateError(`${code} não pode ser ${req.status}:\n- ${result.problems.join('\n- ')}`);
    this.db
      .prepare(`UPDATE scenarios SET status = ?, classification = ?, observed = COALESCE(?, observed), reason = COALESCE(?, reason), confidence = ?, confidence_score = ? WHERE id = ?`)
      .run(req.status, req.classification ?? null, req.observed ?? null, req.reason ?? null, result.confidence, result.score, s.id);
    this.logEvent(runId, s.id, 'scenario.reclassify', { from: before, to: { status: req.status, classification: req.classification ?? null }, justification });
    return { code, from: before, to: { status: req.status, classification: req.classification ?? null } };
  }

  addExploratory(runId: string, input: ExploratoryInput): ScenarioRow {
    this.requireExecuting(runId);
    if (input.parentCode) this.getScenario(runId, input.parentCode);
    const row = this.db
      .prepare(
        `SELECT COALESCE(MAX(seq), 0) AS seq,
                SUM(CASE WHEN origin = 'exploratory' THEN 1 ELSE 0 END) AS exp
         FROM scenarios WHERE run_id = ?`,
      )
      .get(runId) as { seq: number; exp: number | null };
    const code = `EXP-${String((row.exp ?? 0) + 1).padStart(3, '0')}`;
    this.db
      .prepare(
        `INSERT INTO scenarios (run_id, code, title, priority, types, risk, origin, parent_code, preconditions, steps, expected, seq)
         VALUES (?, ?, ?, ?, ?, ?, 'exploratory', ?, ?, ?, ?, ?)`,
      )
      .run(runId, code, input.title, input.priority, JSON.stringify(input.types), input.risk, input.parentCode ?? null,
        input.preconditions ?? null, JSON.stringify(input.steps), input.expected, row.seq + 1);
    this.logEvent(runId, null, 'scenario.add', { code, parent: input.parentCode ?? null });
    return this.getScenario(runId, code);
  }

  /** Início da tentativa atual do cenário: o que veio antes (ex.: tentativa reaberta) não conta. */
  private attemptStart(scenarioId: number): string {
    const row = this.db.prepare('SELECT started_at FROM scenarios WHERE id = ?').get(scenarioId) as { started_at: string | null };
    return row.started_at ?? '';
  }

  completionFacts(scenario: ScenarioRow): CompletionFacts {
    const since = this.attemptStart(scenario.id);
    const verifications = this.db
      .prepare('SELECT kind, description, passed FROM verifications WHERE scenario_id = ? AND ts >= ? ORDER BY id')
      .all(scenario.id, since) as { kind: VerificationKind; description: string; passed: number }[];
    const count = (sql: string, ...params: (string | number)[]) =>
      (this.db.prepare(sql).get(scenario.id, since, ...params) as { n: number }).n;
    const events = (type: string) => count('SELECT COUNT(*) AS n FROM events WHERE scenario_id = ? AND ts >= ? AND type = ?', type);

    // Reprodução objetiva: a mesma checagem refeita e reprovada de novo.
    const failedByKey = new Map<string, number>();
    for (const v of verifications) {
      if (v.passed === 1) continue;
      const key = `${v.kind}|${v.description}`;
      failedByKey.set(key, (failedByKey.get(key) ?? 0) + 1);
    }
    const repeatedFailures = Math.max(0, ...[...failedByKey.values()].map((n) => n - 1));

    return {
      currentStatus: scenario.status,
      priority: scenario.priority,
      verifications: verifications.map((v) => ({ kind: v.kind, description: v.description, passed: v.passed === 1 })),
      evidenceCount: count('SELECT COUNT(*) AS n FROM evidence WHERE scenario_id = ? AND ts >= ?'),
      wroteData: count(`SELECT COUNT(*) AS n FROM actions WHERE scenario_id = ? AND ts >= ? AND ok = 1 AND guard_level IN ('YELLOW','RED')`) > 0,
      investigation: {
        network: events('inspect.network') > 0,
        console: events('inspect.console') > 0,
        api: events('inspect.api') > 0,
        reproductions: repeatedFailures,
      },
      consoleErrors: events('console.error'),
    };
  }

  completeScenario(runId: string, code: string, req: CompletionRequest) {
    this.requireExecuting(runId);
    const scenario = this.getScenario(runId, code);
    const result = evaluateCompletion(req, this.completionFacts(scenario));
    if (!result.ok) throw new StateError(`${code} não pode ser ${req.status}:\n- ${result.problems.join('\n- ')}`);

    transaction(this.db, () => {
      this.db
        .prepare(
          `UPDATE scenarios SET status = ?, classification = ?, observed = ?, reason = ?,
             confidence = ?, confidence_score = ?, ended_at = ? WHERE id = ?`,
        )
        .run(req.status, req.classification ?? null, req.observed ?? null, req.reason ?? null,
          result.confidence, result.score, this.ts(), scenario.id);
      this.db.prepare('UPDATE runs SET current_scenario = NULL WHERE id = ? AND current_scenario = ?').run(runId, code);
    });
    this.logEvent(runId, scenario.id, 'scenario.complete', { status: req.status, confidence: result.confidence });
    const status = this.runStatus(runId);
    return { code, status: req.status as FinalStatus, confidence: result.confidence, notes: result.notes, progress: status.progress, next: status.next };
  }

  // ── Registros produzidos pelas ferramentas (não expostos ao Claude) ─

  recordVerification(runId: string, code: string, v: {
    kind: VerificationKind; description: string; expected?: string; actual?: string; passed: boolean; evidenceId?: number;
    /** Parâmetros da verificação (alvo, condição…), para virar assertion na automação. */
    spec?: unknown;
  }): number {
    const s = this.getScenario(runId, code);
    const result = this.db
      .prepare(
        `INSERT INTO verifications (run_id, scenario_id, kind, description, expected, actual, passed, evidence_id, ts, spec_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(runId, s.id, v.kind, v.description, v.expected ?? null, v.actual ?? null, v.passed ? 1 : 0, v.evidenceId ?? null, this.ts(),
        v.spec === undefined ? null : JSON.stringify(v.spec));
    return Number(result.lastInsertRowid);
  }

  recordEvidence(runId: string, code: string | null, e: { kind: string; path?: string; sha256?: string; meta?: unknown }): number {
    const scenarioId = code ? this.getScenario(runId, code).id : null;
    const result = this.db
      .prepare(`INSERT INTO evidence (run_id, scenario_id, kind, path, sha256, sanitized, meta, ts) VALUES (?, ?, ?, ?, ?, 1, ?, ?)`)
      .run(runId, scenarioId, e.kind, e.path ?? null, e.sha256 ?? null, e.meta === undefined ? null : JSON.stringify(e.meta), this.ts());
    return Number(result.lastInsertRowid);
  }

  recordAction(runId: string, code: string | null, a: {
    action: string; target?: unknown; valueRef?: string; guardLevel: 'GREEN' | 'YELLOW' | 'RED'; ok: boolean;
    error?: string; url?: string; durationMs?: number;
    /** Só valor literal (nunca de valueRef/segredo): massa de exemplo para a automação. */
    valueSample?: string;
  }): number {
    const scenarioId = code ? this.getScenario(runId, code).id : null;
    const seq = (this.db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM actions WHERE run_id = ?').get(runId) as { n: number }).n;
    const result = this.db
      .prepare(
        `INSERT INTO actions (run_id, scenario_id, seq, action, target_json, value_ref, guard_level, ok, error, url, duration_ms, ts, value_sample)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(runId, scenarioId, seq, a.action, a.target === undefined ? null : JSON.stringify(a.target), a.valueRef ?? null,
        a.guardLevel, a.ok ? 1 : 0, a.error ?? null, a.url ?? null, a.durationMs ?? null, this.ts(), a.valueSample?.slice(0, 200) ?? null);
    return Number(result.lastInsertRowid);
  }

  recordApproval(runId: string, a: { action: string; target: string; level: string; justification: string }): number {
    const result = this.db
      .prepare(`INSERT INTO approvals (run_id, action, target, level, decision, ts) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(runId, a.action, a.target, a.level, `APPROVED: ${a.justification}`, this.ts());
    return Number(result.lastInsertRowid);
  }

  // ── Dados criados e limpeza ──────────────────────────────────────────

  /** Criação detectada automaticamente (POST 2xx disparado por ação YELLOW/RED). */
  addCreatedCandidate(runId: string, code: string | null, resource: string, extId: string | undefined): number {
    const scenarioId = code ? this.getScenario(runId, code).id : null;
    const result = this.db
      .prepare(`INSERT INTO created_data (run_id, scenario_id, resource, ext_id, cleanup_status, ts) VALUES (?, ?, ?, ?, 'UNREGISTERED', ?)`)
      .run(runId, scenarioId, resource, extId ?? null, this.ts());
    this.logEvent(runId, scenarioId, 'data.detected', { resource, extId: extId ?? null });
    return Number(result.lastInsertRowid);
  }

  /** Registra (ou completa um candidato detectado com) o plano de limpeza. */
  registerCreatedData(runId: string, input: { id?: number; resource?: string; extId?: string; cleanup: CleanupSpec }): CreatedDataRow {
    this.getRun(runId);
    const status: CleanupStatus = input.cleanup.method === 'keep' ? 'KEPT' : 'PENDING';
    let id = input.id;
    if (id !== undefined) {
      const row = this.getCreatedData(runId, id);
      if (row.cleanup_status === 'VERIFIED') throw new StateError(`#${id} já foi limpo e verificado`);
      this.db
        .prepare('UPDATE created_data SET cleanup_json = ?, cleanup_status = ?, ext_id = COALESCE(?, ext_id) WHERE id = ?')
        .run(JSON.stringify(input.cleanup), status, input.extId ?? null, id);
    } else {
      if (!input.resource) throw new StateError('informe id (candidato detectado) ou resource');
      const code = this.getRun(runId).current_scenario;
      const scenarioId = code ? this.getScenario(runId, code).id : null;
      id = Number(
        this.db
          .prepare(`INSERT INTO created_data (run_id, scenario_id, resource, ext_id, cleanup_json, cleanup_status, ts) VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run(runId, scenarioId, input.resource, input.extId ?? null, JSON.stringify(input.cleanup), status, this.ts()).lastInsertRowid,
      );
    }
    this.logEvent(runId, null, 'data.register', { id, method: input.cleanup.method });
    return this.getCreatedData(runId, id);
  }

  getCreatedData(runId: string, id: number): CreatedDataRow {
    const row = this.db.prepare('SELECT * FROM created_data WHERE run_id = ? AND id = ?').get(runId, id) as CreatedDataRow | undefined;
    if (!row) throw new StateError(`dado criado #${id} não existe no run ${runId}`);
    return row;
  }

  listCreatedData(runId: string): CreatedDataRow[] {
    return this.db.prepare('SELECT * FROM created_data WHERE run_id = ? ORDER BY id').all(runId) as unknown as CreatedDataRow[];
  }

  setCleanupStatus(runId: string, id: number, status: 'VERIFIED' | 'FAILED', note: string): void {
    this.db
      .prepare('UPDATE created_data SET cleanup_status = ?, verified_at = ? WHERE run_id = ? AND id = ?')
      .run(status, status === 'VERIFIED' ? this.ts() : null, runId, id);
    this.logEvent(runId, null, `cleanup.${status.toLowerCase()}`, { id, note });
  }

  /**
   * Ações bem-sucedidas seguidas de verificação aprovada (ARCHITECTURE.md D1): no mesmo cenário,
   * ou — para ações de setup fora de cenário, como login — em qualquer cenário depois delas.
   */
  validatedActions(runId: string): ValidatedActionRow[] {
    return this.db
      .prepare(
        `SELECT a.action, a.target_json, a.value_ref, a.url, a.ts, COALESCE(s.code, '(setup)') AS scenario
         FROM actions a LEFT JOIN scenarios s ON s.id = a.scenario_id
         WHERE a.run_id = ? AND a.ok = 1
           AND EXISTS (SELECT 1 FROM verifications v
                       WHERE v.passed = 1 AND v.ts >= a.ts
                         AND (v.scenario_id = a.scenario_id OR (a.scenario_id IS NULL AND v.run_id = a.run_id)))
         ORDER BY a.seq`,
      )
      .all(runId) as unknown as ValidatedActionRow[];
  }

  logEvent(runId: string | null, scenarioId: number | null, type: string, payload: unknown): void {
    this.db
      .prepare('INSERT INTO events (run_id, scenario_id, type, payload, ts) VALUES (?, ?, ?, ?, ?)')
      .run(runId, scenarioId, type, payload === null || payload === undefined ? null : JSON.stringify(payload), this.ts());
  }
}

export type { Classification, CompletionRequest };
