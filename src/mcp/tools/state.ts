import { z } from 'zod';
import type { BrowserService } from '../../browser/service.ts';
import { writeExecutionKnowledge } from '../../knowledge/execution.ts';
import { CLASSIFICATIONS, CONFIDENCE_LEVELS, FINAL_STATUSES } from '../../state/rules.ts';
import type { StateStore } from '../../state/store.ts';
import type { RegisterTool } from '../tooling.ts';

const priority = z.enum(['P0', 'P1', 'P2', 'P3']);
const risk = z.enum(['HIGH', 'MEDIUM', 'LOW']);
const scenarioFields = {
  title: z.string().min(3),
  priority,
  risk,
  types: z.array(z.string()).describe('ex.: functional, permission, validation, regression'),
  preconditions: z.string().optional(),
  steps: z.array(z.string()).min(1),
  expected: z.string().min(3),
};

export function registerStateTools(tool: RegisterTool, deps: { store: StateStore; rootDir: string; browser?: BrowserService }): void {
  const { store, rootDir, browser } = deps;

  tool(
    'run_start',
    'Inicia um run de QA para um card. Retorna runId.',
    {
      issueKey: z.string().regex(/^[A-Z][A-Z0-9]+-\d+$/),
      env: z.string().describe('id em config/environments.yaml'),
      mode: z.enum(['manual', 'explore', 'automate', 'retest']),
      parentRunId: z.string().optional().describe('obrigatório em retest'),
    },
    (a) => {
      const run = store.startRun(a);
      return { runId: run.id, status: run.status };
    },
  );

  tool(
    'run_status',
    'Progresso de um run (por runId ou chave do card → run mais recente): contagens, em andamento, próximo cenário.',
    { runIdOrKey: z.string() },
    (a) => store.runStatus(a.runIdOrKey),
  );

  tool(
    'run_complete',
    'Conclui o run (exige todos os cenários com status final), grava o execution knowledge e fecha o navegador.',
    {
      runId: z.string(),
      recommendation: z.enum(['APROVADO', 'REPROVADO', 'INCONCLUSIVO']),
      summary: z.string().min(3),
    },
    async (a) => {
      const run = store.completeRun(a.runId, a.recommendation, a.summary);
      const knowledge = writeExecutionKnowledge(rootDir, store, run);
      await browser?.close();
      return { runId: run.id, status: run.status, executionKnowledge: knowledge };
    },
  );

  tool(
    'run_abort',
    'Aborta um run ativo.',
    { runId: z.string(), reason: z.string().min(3) },
    async (a) => {
      const run = store.abortRun(a.runId, a.reason);
      await browser?.close();
      return { runId: run.id, status: run.status };
    },
  );

  tool(
    'plan_save',
    'Salva/substitui o plano (cenários CT-NNN, em ordem de execução). Deixa o run aguardando aprovação humana. ' +
      'modules: módulos de conhecimento do card (o primeiro recebe o execution knowledge do run).',
    {
      runId: z.string(),
      scenarios: z.array(z.object({ code: z.string(), ...scenarioFields })).min(1),
      modules: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]*$/)).optional(),
    },
    (a) => store.savePlan(a.runId, a.scenarios, a.modules),
  );

  tool(
    'plan_approve',
    'Registra a aprovação humana do plano. Chame somente depois que o usuário aprovar explicitamente.',
    { runId: z.string() },
    (a) => {
      const run = store.approvePlan(a.runId);
      return { runId: run.id, status: run.status };
    },
  );

  tool(
    'scenario_start',
    'Inicia (ou retoma) um cenário. Abre a janela de network/console/trace do cenário.',
    { runId: z.string(), code: z.string() },
    async (a) => {
      const s = store.startScenario(a.runId, a.code);
      await browser?.onScenarioStart(a.runId, a.code);
      return { code: s.code, status: s.status, resumed: s.resumed };
    },
  );

  tool(
    'scenario_reopen',
    'Reabre cenário BLOCKED/NOT_EXECUTED/NEEDS_REVIEW no mesmo run quando a causa deixou de existir (ex.: ambiente voltou). ' +
      'A tentativa anterior fica no histórico mas não conta para a conclusão. PASSED/FAILED não reabrem.',
    { runId: z.string(), code: z.string(), reason: z.string().min(10) },
    (a) => {
      const s = store.reopenScenario(a.runId, a.code, a.reason);
      return { code: s.code, status: s.status };
    },
  );

  tool(
    'scenario_reclassify',
    'Corrige status/classificação de um resultado FAILED/NEEDS_REVIEW/BLOCKED sem refazer o cenário (ex.: PRODUCT_BUG que é divergência de requisito → NEEDS_REVIEW/REQUIREMENT_AMBIGUITY). ' +
      'As regras de conclusão valem de novo; a mudança e a justificativa ficam no relatório. Use também após o run concluído (depois regere o relatório).',
    {
      runId: z.string(),
      code: z.string(),
      status: z.enum(['FAILED', 'NEEDS_REVIEW', 'BLOCKED']),
      classification: z.enum(CLASSIFICATIONS).optional(),
      observed: z.string().optional(),
      reason: z.string().optional(),
      justification: z.string().min(15),
    },
    (a) => {
      const { runId, code, justification, ...req } = a;
      return store.reclassifyScenario(runId, code, req, justification);
    },
  );

  tool(
    'scenario_add',
    'Cria cenário exploratório (EXP-NNN) durante a execução, opcionalmente derivado de outro.',
    { runId: z.string(), parentCode: z.string().optional(), ...scenarioFields },
    (a) => {
      const { runId, ...input } = a;
      const s = store.addExploratory(runId, input);
      return { code: s.code, status: s.status };
    },
  );

  tool(
    'scenario_complete',
    'Conclui um cenário. PASSED/FAILED exigem verificações registradas por verify; confidence é calculada pela rubrica (a sua só pode rebaixar).',
    {
      runId: z.string(),
      code: z.string(),
      status: z.enum(FINAL_STATUSES),
      classification: z.enum(CLASSIFICATIONS).optional(),
      observed: z.string().optional(),
      reason: z.string().optional(),
      confidence: z.enum(CONFIDENCE_LEVELS).optional(),
    },
    async (a) => {
      const { runId, code, ...req } = a;
      const result = store.completeScenario(runId, code, req);
      await browser?.onScenarioEnd(runId, code, req.status);
      return result;
    },
  );
}
