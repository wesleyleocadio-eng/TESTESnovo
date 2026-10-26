import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/load.ts';
import { openDb, type Db } from '../src/state/db.ts';
import { StateStore, type ScenarioInput } from '../src/state/store.ts';

const config = loadConfig(join(import.meta.dirname, '..'));
const ENV = 'fixture-local';

function scenario(code: string, over: Partial<ScenarioInput> = {}): ScenarioInput {
  return { code, title: `Cenário ${code}`, priority: 'P2', risk: 'MEDIUM', types: ['functional'], steps: ['passo'], expected: 'resultado', ...over };
}

let db: Db;
let store: StateStore;
let clock: Date;

beforeEach(() => {
  db = openDb(':memory:');
  clock = new Date('2026-10-23T10:00:00Z');
  store = new StateStore(db, config, { now: () => clock });
});

function approvedRun(scenarios = [scenario('CT-001'), scenario('CT-002'), scenario('CT-003')]): string {
  const run = store.startRun({ issueKey: 'FIX-1', env: ENV, mode: 'manual' });
  store.savePlan(run.id, scenarios);
  store.approvePlan(run.id);
  return run.id;
}

describe('runs', () => {
  it('cria run com id legível e status PLANNING', () => {
    const run = store.startRun({ issueKey: 'FIX-1', env: ENV, mode: 'manual' });
    expect(run.id).toBe('FIX-1-20261023T100000');
    expect(run.status).toBe('PLANNING');
    expect(run.project).toBe('fixture');
  });

  it('recusa ambiente desconhecido e segundo run ativo do mesmo card', () => {
    expect(() => store.startRun({ issueKey: 'FIX-1', env: 'nao-existe', mode: 'manual' })).toThrow(/não existe/);
    store.startRun({ issueKey: 'FIX-1', env: ENV, mode: 'manual' });
    expect(() => store.startRun({ issueKey: 'FIX-1', env: ENV, mode: 'manual' })).toThrow(/já existe run ativo/);
  });

  it('retest exige run pai concluído do mesmo card', () => {
    expect(() => store.startRun({ issueKey: 'FIX-1', env: ENV, mode: 'retest' })).toThrow(/parentRunId/);
    const parent = approvedRun([scenario('CT-001')]);
    expect(() => store.startRun({ issueKey: 'FIX-1', env: ENV, mode: 'retest', parentRunId: parent })).toThrow(/já existe run ativo/);
    store.completeScenario(parent, 'CT-001', { status: 'NOT_EXECUTED', reason: 'teste' });
    store.completeRun(parent, 'INCONCLUSIVO', 'resumo');
    clock = new Date('2026-10-24T10:00:00Z');
    const retest = store.startRun({ issueKey: 'FIX-1', env: ENV, mode: 'retest', parentRunId: parent });
    store.savePlan(retest.id, [scenario('CT-001')]);
    expect(db.prepare("SELECT origin FROM scenarios WHERE run_id = ?").get(retest.id)).toEqual({ origin: 'retest' });
  });
});

describe('plano e aprovação', () => {
  it('não executa antes da aprovação humana', () => {
    const run = store.startRun({ issueKey: 'FIX-1', env: ENV, mode: 'manual' });
    store.savePlan(run.id, [scenario('CT-001')]);
    expect(() => store.startScenario(run.id, 'CT-001')).toThrow(/aguardando aprovação/);
  });

  it('plano pode ser revisado antes, não depois da aprovação', () => {
    const run = store.startRun({ issueKey: 'FIX-1', env: ENV, mode: 'manual' });
    store.savePlan(run.id, [scenario('CT-001')]);
    store.savePlan(run.id, [scenario('CT-001'), scenario('CT-002')]);
    expect(store.listScenarios(run.id)).toHaveLength(2);
    store.approvePlan(run.id);
    expect(() => store.savePlan(run.id, [scenario('CT-001')])).toThrow(/scenario_add/);
    expect(db.prepare("SELECT decision FROM approvals WHERE run_id = ?").get(run.id)).toEqual({ decision: 'APPROVED' });
  });

  it('valida códigos', () => {
    const run = store.startRun({ issueKey: 'FIX-1', env: ENV, mode: 'manual' });
    expect(() => store.savePlan(run.id, [scenario('T1')])).toThrow(/código inválido/);
    expect(() => store.savePlan(run.id, [scenario('CT-001'), scenario('CT-001')])).toThrow(/duplicado/);
  });
});

describe('execução', () => {
  it('fluxo completo: PASS com verificação, FAIL com evidência, checkpoint e conclusão', () => {
    const runId = approvedRun();

    store.startScenario(runId, 'CT-001');
    expect(() => store.completeScenario(runId, 'CT-001', { status: 'PASSED' })).toThrow(/verificação aprovada/);
    store.recordVerification(runId, 'CT-001', { kind: 'ui', description: 'mensagem de sucesso', passed: true });
    store.recordVerification(runId, 'CT-001', { kind: 'network', description: 'POST /alunos 201', passed: true });
    const pass = store.completeScenario(runId, 'CT-001', { status: 'PASSED' });
    expect(pass).toMatchObject({ status: 'PASSED', confidence: 'HIGH', progress: '1/3', next: 'CT-002' });

    store.startScenario(runId, 'CT-002');
    store.recordVerification(runId, 'CT-002', { kind: 'ui', description: 'filtro aplicado', passed: false });
    store.recordEvidence(runId, 'CT-002', { kind: 'screenshot', path: 'x.png' });
    store.logEvent(runId, store.getScenario(runId, 'CT-002').id, 'inspect.network', null);
    const fail = store.completeScenario(runId, 'CT-002', { status: 'FAILED', classification: 'PRODUCT_BUG', observed: 'lista não filtrou' });
    expect(fail).toMatchObject({ status: 'FAILED', confidence: 'MEDIUM' });

    expect(() => store.completeRun(runId, 'REPROVADO', 'x')).toThrow(/CT-003/);
    store.completeScenario(runId, 'CT-003', { status: 'BLOCKED', reason: 'massa ausente', classification: 'TEST_DATA_FAILURE' });
    expect(store.completeRun(runId, 'REPROVADO', '1 bug').status).toBe('COMPLETED');
  });

  it('escrita de dados em P0 exige verificação forte', () => {
    const runId = approvedRun([scenario('CT-001', { priority: 'P0' })]);
    store.startScenario(runId, 'CT-001');
    store.recordAction(runId, 'CT-001', { action: 'click', target: { role: 'button', name: 'Salvar' }, guardLevel: 'YELLOW', ok: true });
    store.recordVerification(runId, 'CT-001', { kind: 'ui', description: 'toast', passed: true });
    expect(() => store.completeScenario(runId, 'CT-001', { status: 'PASSED' })).toThrow(/verificação forte/);
    store.recordVerification(runId, 'CT-001', { kind: 'persistence', description: 'após reload', passed: true });
    expect(store.completeScenario(runId, 'CT-001', { status: 'PASSED' }).status).toBe('PASSED');
  });

  it('reabre BLOCKED quando a causa some; a tentativa anterior não conta para concluir', () => {
    const runId = approvedRun([scenario('CT-001'), scenario('CT-002')]);
    store.startScenario(runId, 'CT-001');
    store.recordVerification(runId, 'CT-001', { kind: 'ui', description: 'modal abre', passed: true });
    store.recordVerification(runId, 'CT-001', { kind: 'ui', description: 'abas visíveis', passed: false });
    store.completeScenario(runId, 'CT-001', { status: 'BLOCKED', reason: 'build antigo no ar', classification: 'ENVIRONMENT_FAILURE' });

    expect(() => store.reopenScenario(runId, 'CT-001', 'curto')).toThrow(/motivo/);
    expect(store.reopenScenario(runId, 'CT-001', 'ambiente voltou ao build do facelift').status).toBe('PENDING');
    expect(db.prepare(`SELECT payload FROM events WHERE type = 'scenario.reopen'`).get()).toEqual({ payload: JSON.stringify({ from: 'BLOCKED', reason: 'ambiente voltou ao build do facelift' }) });

    clock = new Date('2026-10-23T11:00:00Z');
    store.startScenario(runId, 'CT-001');
    // A verificação aprovada da tentativa anterior não vale…
    expect(() => store.completeScenario(runId, 'CT-001', { status: 'PASSED' })).toThrow(/ao menos 1 verificação aprovada/);
    // …e a reprovada antiga também não bloqueia: só a tentativa atual conta.
    store.recordVerification(runId, 'CT-001', { kind: 'ui', description: 'modal abre', passed: true });
    expect(store.completeScenario(runId, 'CT-001', { status: 'PASSED' }).status).toBe('PASSED');
    expect(store.scenarioProgress(store.getScenario(runId, 'CT-001').id).verified).toEqual(['ui: modal abre (passou)']);

    expect(() => store.reopenScenario(runId, 'CT-001', 'tentar reabrir resultado válido')).toThrow(/PASSED\/FAILED não reabrem|só BLOCKED/);
  });

  it('reclassifica FAILED/PRODUCT_BUG para NEEDS_REVIEW com justificativa, mesmo com o run concluído', () => {
    const runId = approvedRun([scenario('CT-001')]);
    store.startScenario(runId, 'CT-001');
    store.recordVerification(runId, 'CT-001', { kind: 'ui', description: 'contagem zerada', passed: false });
    store.recordEvidence(runId, 'CT-001', { kind: 'screenshot', path: 'x.png' });
    store.logEvent(runId, store.getScenario(runId, 'CT-001').id, 'inspect.network', null);
    store.completeScenario(runId, 'CT-001', { status: 'FAILED', classification: 'PRODUCT_BUG', observed: 'contagem continua' });
    store.completeRun(runId, 'INCONCLUSIVO', 'divergência');

    expect(() => store.reclassifyScenario(runId, 'CT-001', { status: 'NEEDS_REVIEW', classification: 'REQUIREMENT_AMBIGUITY', reason: 'x' }, 'curta')).toThrow(/justificativa/);
    expect(() => store.reclassifyScenario(runId, 'CT-001', { status: 'NEEDS_REVIEW', classification: 'REQUIREMENT_AMBIGUITY' }, 'o card não define o reset da contagem')).toThrow(/reason/);
    const r = store.reclassifyScenario(runId, 'CT-001', { status: 'NEEDS_REVIEW', classification: 'REQUIREMENT_AMBIGUITY', reason: 'reset só no comentário da dev' }, 'o card não define o reset da contagem');
    expect(r).toEqual({ code: 'CT-001', from: { status: 'FAILED', classification: 'PRODUCT_BUG' }, to: { status: 'NEEDS_REVIEW', classification: 'REQUIREMENT_AMBIGUITY' } });
    expect(db.prepare(`SELECT status, classification, observed FROM scenarios WHERE run_id = ?`).get(runId)).toEqual({ status: 'NEEDS_REVIEW', classification: 'REQUIREMENT_AMBIGUITY', observed: 'contagem continua' });
    // PASSED não se reclassifica por aqui
    expect(() => store.reclassifyScenario(runId, 'CT-001', { status: 'PASSED' as never }, 'tentando virar passed sem verificar')).toThrow(/só entre/);
  });

  it('um cenário por vez; retomar o mesmo é idempotente', () => {
    const runId = approvedRun();
    store.startScenario(runId, 'CT-001');
    expect(() => store.startScenario(runId, 'CT-002')).toThrow(/conclua CT-001/);
    expect(store.startScenario(runId, 'CT-001').resumed).toBe(true);
  });

  it('exploratório recebe EXP-NNN e entra no fim da fila', () => {
    const runId = approvedRun();
    const exp = store.addExploratory(runId, { title: 'Anomalia na paginação', priority: 'P1', risk: 'HIGH', types: ['exploratory'], steps: ['x'], expected: 'y', parentCode: 'CT-002' });
    expect(exp.code).toBe('EXP-001');
    expect(store.addExploratory(runId, { title: 'Outra', priority: 'P2', risk: 'LOW', types: [], steps: ['x'], expected: 'y' }).code).toBe('EXP-002');
    expect(store.listScenarios(runId).map((s) => s.code)).toEqual(['CT-001', 'CT-002', 'CT-003', 'EXP-001', 'EXP-002']);
    expect(() => store.addExploratory(runId, { title: 'x x', priority: 'P2', risk: 'LOW', types: [], steps: ['x'], expected: 'yyy', parentCode: 'CT-999' })).toThrow(/não existe/);
  });

  it('runStatus por chave do card mostra retomada', () => {
    const runId = approvedRun();
    store.startScenario(runId, 'CT-001');
    store.recordVerification(runId, 'CT-001', { kind: 'ui', description: 'ok', passed: true });
    store.completeScenario(runId, 'CT-001', { status: 'PASSED' });
    store.startScenario(runId, 'CT-002');
    expect(store.runStatus('FIX-1')).toMatchObject({
      run: { id: runId, status: 'EXECUTING' },
      progress: '1/3',
      counts: { PASSED: 1, IN_PROGRESS: 1, PENDING: 1 },
      inProgress: ['CT-002'],
      next: 'CT-002',
    });
  });

  it('estado sobrevive a reabrir o banco (checkpoint em disco)', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'novo-qa-db-'));
    const path = join(dir, 'state.db');
    const db1 = openDb(path);
    try {
      const s1 = new StateStore(db1, config);
      const run = s1.startRun({ issueKey: 'FIX-9', env: ENV, mode: 'manual' });
      s1.savePlan(run.id, [scenario('CT-001'), scenario('CT-002')]);
      s1.approvePlan(run.id);
      s1.startScenario(run.id, 'CT-001');

      const db2 = openDb(path);
      const s2 = new StateStore(db2, config);
      expect(s2.runStatus('FIX-9')).toMatchObject({ progress: '0/2', next: 'CT-001', inProgress: ['CT-001'] });
      db2.close();
    } finally {
      db1.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
