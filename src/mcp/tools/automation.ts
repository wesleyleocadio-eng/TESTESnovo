import { z } from 'zod';
import { runPlaywright, recordAutomationRun } from '../../automation/runner.ts';
import { scaffoldProject } from '../../automation/scaffold.ts';
import { buildAutomationSpec } from '../../automation/spec.ts';
import { assessSuitability, SuitabilityFactors } from '../../automation/suitability.ts';
import { StateError } from '../../state/store.ts';
import type { RegisterTool } from '../tooling.ts';
import type { QaDeps } from './qa.ts';

export interface AutomationDeps extends QaDeps {
  /** Só para testes: aponta a suíte para o app fixture (porta dinâmica). Não exposto ao modelo. */
  automationBaseUrl?: string;
}

export function registerAutomationTools(tool: RegisterTool, deps: AutomationDeps): void {
  const { db, store, config, rootDir } = deps;
  const now = () => new Date().toISOString();

  /** Run de origem da automação: o mais recente do card com cenários aprovados para automatizar. */
  const sourceRun = (issueKey: string) => {
    const row = db
      .prepare(
        `SELECT r.id FROM runs r WHERE r.issue_key = ? AND r.status = 'COMPLETED'
           AND EXISTS (SELECT 1 FROM scenarios s WHERE s.run_id = r.id AND s.automation_approved = 1)
         ORDER BY r.started_at DESC, r.rowid DESC LIMIT 1`,
      )
      .get(issueKey) as { id: string } | undefined;
    if (!row) throw new StateError(`nenhum run concluído de ${issueKey} com cenários aprovados para automação`);
    return store.getRun(row.id);
  };

  tool(
    'automation_assess',
    'Avalia quais cenários de um run concluído devem ser automatizados. Você avalia os fatores; o score é calculado ' +
      '(HIGH ≥80 entra; MEDIUM só com include.reason; LOW nunca; só cenários PASSED).',
    {
      runId: z.string(),
      assessments: z.array(z.strictObject({ code: z.string(), factors: SuitabilityFactors, include: z.strictObject({ reason: z.string().min(10) }).optional() })).min(1),
    },
    (a) => {
      const run = store.getRun(a.runId);
      if (run.status !== 'COMPLETED') throw new StateError(`run está ${run.status}: automação nasce de teste manual concluído`);
      const update = db.prepare('UPDATE scenarios SET automation_suitability = ?, automation_approved = ? WHERE id = ?');
      const result = a.assessments.map((x) => {
        const s = store.getScenario(run.id, x.code);
        const detail = store.scenarioDetails(run.id).find((d) => d.id === s.id)!;
        const validatedActions = (db.prepare('SELECT COUNT(*) AS n FROM actions WHERE scenario_id = ? AND ok = 1').get(s.id) as { n: number }).n;
        const suit = assessSuitability(x.factors, { status: s.status, confidence: detail.confidence, validatedActions }, x.include);
        update.run(JSON.stringify({ ...suit, factors: x.factors }), suit.automate ? 1 : 0, s.id);
        return `${x.code} ${suit.score} ${suit.level} ${suit.automate ? '→ automatizar' : '→ fora'}${suit.reasons.length ? ` (${suit.reasons.join('; ')})` : ''}`;
      });
      store.logEvent(run.id, null, 'automation.assess', { count: a.assessments.length });
      return { runId: run.id, assessed: result };
    },
  );

  tool(
    'automation_spec',
    'Gera automation/<projeto>/specs/<card>/ (AUTOMATION.md, test-data.json, execution-knowledge.json) a partir do teste manual e ' +
      'garante a estrutura do projeto (playwright.config, env.ts, fixtures com guard). Reinicia a contagem de tentativas.',
    { runId: z.string() },
    (a) => {
      const run = store.getRun(a.runId);
      const scaffold = scaffoldProject(rootDir, config, run.project);
      const spec = buildAutomationSpec({ db, store, cache: deps.cache, rootDir, redactor: deps.redactor }, run.id);
      store.logEvent(run.id, null, 'automation.spec', { issueKey: run.issue_key });
      return { ...spec, project: scaffold.dir, scaffolded: scaffold.created, testsDir: `automation/${run.project}/tests/${run.issue_key}` };
    },
  );

  tool(
    'automation_run',
    'Executa a suíte gerada do card. validate=false: tentativa (conta no limite de correções). validate=true: validação final ' +
      '(cada teste 2×; flaky não passa) — só depois de uma tentativa 100% verde. Entregue = validação sem falha nem flaky.',
    { issueKey: z.string().regex(/^[A-Z][A-Z0-9]+-\d+$/), validate: z.boolean().optional(), grep: z.string().optional() },
    async (a) => {
      const run = sourceRun(a.issueKey);
      const specTs = (db.prepare(`SELECT MAX(ts) AS ts FROM events WHERE run_id = ? AND type = 'automation.spec'`).get(run.id) as { ts: string | null }).ts;
      if (!specTs) throw new StateError('rode automation_spec antes');
      const attempts = (db.prepare(`SELECT COUNT(*) AS n FROM automation_runs WHERE run_id = ? AND kind = 'attempt' AND started_at > ?`).get(run.id, specTs) as { n: number }).n;
      const limit = config.policy.automation.maxFixAttempts + 1;
      const validation = a.validate === true;

      if (!validation && attempts >= limit) {
        throw new StateError(`limite de ${limit} tentativas atingido (1 + ${config.policy.automation.maxFixAttempts} correções): pare, classifique o que falta e relate`);
      }
      if (validation) {
        const last = db.prepare(`SELECT total, passed FROM automation_runs WHERE run_id = ? AND kind = 'attempt' AND started_at > ? ORDER BY id DESC LIMIT 1`).get(run.id, specTs) as { total: number; passed: number } | undefined;
        if (!last || last.total === 0 || last.passed !== last.total) throw new StateError('validação só depois de uma tentativa com todos os testes passando');
      }

      const startedAt = now();
      const out = await runPlaywright({
        rootDir, project: run.project, issueKey: a.issueKey, validation, envId: run.env, grep: a.grep, baseUrl: deps.automationBaseUrl,
      });
      const id = recordAutomationRun(db, { issueKey: a.issueKey, project: run.project, runId: run.id, kind: validation ? 'validation' : 'attempt', startedAt, endedAt: now(), exitCode: out.exitCode, reportPath: out.reportPath, report: out.report });
      const t = out.report.tests;
      const allGreen = t.length > 0 && t.every((x) => x.status === 'passed');
      if (validation && allGreen) store.logEvent(run.id, null, 'automation.validated', { automationRunId: id });

      return {
        kind: validation ? 'validation' : `attempt ${attempts + 1}/${limit}`,
        total: t.length,
        passed: t.filter((x) => x.status === 'passed').length,
        failed: t.filter((x) => x.status === 'failed').map((x) => ({ title: x.title, error: x.error, ...(x.blocked ? { blocked: x.blocked } : {}) })),
        flaky: t.filter((x) => x.status === 'flaky').map((x) => x.title),
        ...(out.report.errors.length ? { errors: out.report.errors } : {}),
        ...(t.length === 0 ? { output: out.output } : {}),
        report: out.reportPath,
        ...(validation ? { delivered: allGreen } : {}),
      };
    },
  );
}
