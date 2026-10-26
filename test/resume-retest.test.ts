import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { createHarness, loggedInRun, restart, type Harness } from './harness.ts';

let h: Harness;
afterEach(async () => h?.close());

const heading = { role: 'heading', name: 'Alunos' };

describe('retomada após interrupção', () => {
  it('reinicia servidor e navegador e continua do cenário interrompido, sem repetir os concluídos', async () => {
    h = await createHarness();
    const runId = await loggedInRun(h, 'FIX-60', ['CT-001', 'CT-002', 'CT-003']);
    await h.ok('browser_save_auth');

    await h.ok('scenario_start', { runId, code: 'CT-001' });
    await h.ok('verify', { kind: 'ui', description: 'lista visível', target: heading });
    await h.ok('scenario_complete', { runId, code: 'CT-001', status: 'PASSED' });
    await h.ok('scenario_start', { runId, code: 'CT-002' });
    await h.ok('verify', { kind: 'url', description: 'na lista de alunos', urlPattern: '/students' });
    // — interrupção aqui —

    const r = await restart(h);
    expect(await r.ok('run_status', { runIdOrKey: 'FIX-60' })).toMatchObject({ progress: '1/3', inProgress: ['CT-002'], next: 'CT-002' });

    const brief = parse((await r.call('batch_brief', { runId })).text);
    expect(brief.browser).toEqual({ open: false });
    expect(brief.batch.map((s: { code: string }) => s.code)).toEqual(['CT-002', 'CT-003']);
    expect(brief.batch[0].resume).toEqual({ verified: ['url: na lista de alunos (passou)'], actions: 0 });

    const reopened = await r.ok('browser_open', { runId, role: 'admin' });
    expect(reopened.authReused).toBe(true);
    await r.ok('navigate', { url: '/students', snapshot: false });
    expect((await r.ok('scenario_start', { runId, code: 'CT-002' })).resumed).toBe(true);
    await r.ok('verify', { kind: 'ui', description: 'lista visível', target: heading });
    await r.ok('scenario_complete', { runId, code: 'CT-002', status: 'PASSED' });

    // A verificação feita antes da interrupção conta para o cenário retomado.
    const ct2 = h.db.prepare(`SELECT confidence FROM scenarios WHERE run_id = ? AND code = 'CT-002'`).get(runId);
    expect(ct2).toEqual({ confidence: 'MEDIUM' }); // url + ui (2 fracas)

    await r.ok('scenario_start', { runId, code: 'CT-003' });
    await r.ok('verify', { kind: 'ui', description: 'lista visível', target: heading });
    await r.ok('scenario_complete', { runId, code: 'CT-003', status: 'PASSED' });
    expect((await r.ok('run_status', { runIdOrKey: runId })).progress).toBe('3/3');

    const plan = parse((await r.call('plan_view', { runIdOrKey: 'FIX-60' })).text);
    expect(plan.scenarios).toEqual([
      'CT-001 [P2/MEDIUM] Cenário CT-001 — PASSED',
      'CT-002 [P2/MEDIUM] Cenário CT-002 — PASSED',
      'CT-003 [P2/MEDIUM] Cenário CT-003 — PASSED',
    ]);
    // CT-001 foi executado uma única vez: nenhuma ação/verificação nova depois do reinício.
    const ct1Verifications = h.db.prepare(`SELECT COUNT(*) AS n FROM verifications v JOIN scenarios s ON s.id = v.scenario_id WHERE s.run_id = ? AND s.code = 'CT-001'`).get(runId);
    expect(ct1Verifications).toEqual({ n: 1 });
  }, 90_000);
});

describe('sessão e API autenticada por header', () => {
  it('verify api reaproveita o Authorization da aplicação; fresh faz login do zero mantendo o papel', async () => {
    h = await createHarness();
    const runId = await loggedInRun(h, 'FIX-65', ['CT-001']);
    await h.ok('scenario_start', { runId, code: 'CT-001' });
    // A API /api/profile só aceita Bearer (como o Guruja): sem reaproveitar o header, seria 401.
    const api = await h.ok('verify', { kind: 'api', description: 'perfil via API com token', path: '/api/profile', bodyContains: '"user":"admin"' });
    expect(api.passed).toBe(true);
    expect(api.actual).toMatch(/^200/);
    expect(JSON.stringify(h.transcript)).not.toMatch(/Bearer [0-9a-f]{16,}/);
    await h.ok('scenario_complete', { runId, code: 'CT-001', status: 'PASSED' });

    // fresh: ignora sessão salva, mas o papel continua (dá para salvar de novo).
    await h.ok('browser_save_auth');
    const fresh = await h.ok('browser_open', { runId, role: 'admin', fresh: true });
    expect(fresh).toMatchObject({ authReused: false, role: 'admin' });
    expect(fresh.snapshot).toContain('textbox "Usuário"');
    expect((await h.ok('browser_save_auth')).saved).toBe('fixture-local/admin');
  }, 60_000);
});

describe('reteste', () => {
  it('semente com o que não passou, mesmos códigos, e relatório comparando com o run pai', async () => {
    h = await createHarness();
    const parent = await loggedInRun(h, 'FIX-70', ['CT-001', 'CT-002', 'CT-003']);
    await h.ok('browser_save_auth');
    await h.ok('scenario_start', { runId: parent, code: 'CT-001' });
    await h.ok('verify', { kind: 'ui', description: 'lista visível', target: heading });
    await h.ok('scenario_complete', { runId: parent, code: 'CT-001', status: 'PASSED' });
    await h.ok('scenario_start', { runId: parent, code: 'CT-002' });
    await h.ok('verify', { kind: 'ui', description: 'link de relatórios no menu', target: { role: 'link', name: 'Exportar' }, timeoutMs: 300 });
    await h.ok('console', {});
    await h.ok('scenario_complete', { runId: parent, code: 'CT-002', status: 'FAILED', classification: 'PRODUCT_BUG', observed: 'link Exportar não existe' });
    await h.ok('scenario_complete', { runId: parent, code: 'CT-003', status: 'BLOCKED', classification: 'TEST_DATA_FAILURE', reason: 'sem aluno inativo' });
    await h.ok('run_complete', { runId: parent, recommendation: 'REPROVADO', summary: 'falta o link Exportar' });

    const notRetest = await h.call('retest_seed', { runId: parent });
    expect(notRetest.text).toMatch(/modo retest/);

    const runId = (await h.ok('run_start', { issueKey: 'FIX-70', env: 'fixture-local', mode: 'retest', parentRunId: parent })).runId;
    const seed = parse((await h.call('retest_seed', { runId })).text);
    expect(seed.retest.map((s: { code: string }) => s.code)).toEqual(['CT-002', 'CT-003']);
    expect(seed.retest[0].before).toEqual({ status: 'FAILED', classification: 'PRODUCT_BUG', observed: 'link Exportar não existe' });
    expect(seed.retest[1].before).toMatchObject({ status: 'BLOCKED', reason: 'sem aluno inativo' });
    expect(seed.passedBefore).toEqual(['CT-001 [P2/MEDIUM] Cenário CT-001']);
    expect(seed.nextCode).toBe('CT-004');

    // Plano do reteste: os que não passaram + um vizinho, com os mesmos códigos.
    const keep = (s: Record<string, unknown>) => ({ code: s.code, title: s.title, priority: s.priority, risk: s.risk, types: s.types, steps: s.steps, expected: s.expected });
    await h.ok('plan_save', {
      runId,
      scenarios: [...seed.retest.map(keep), { code: 'CT-001', title: 'Cenário CT-001', priority: 'P2', risk: 'MEDIUM', types: ['regression'], steps: ['ver lista'], expected: 'lista visível' }],
    });
    await h.ok('plan_approve', { runId });
    expect((await h.ok('browser_open', { runId, role: 'admin' })).authReused).toBe(true);
    await h.ok('navigate', { url: '/students', snapshot: false });

    // CT-002 agora passa (correção), CT-003 continua bloqueado, CT-001 regrediu.
    await h.ok('scenario_start', { runId, code: 'CT-002' });
    await h.ok('verify', { kind: 'ui', description: 'link de relatórios no menu', target: { role: 'link', name: 'Relatórios' } });
    await h.ok('scenario_complete', { runId, code: 'CT-002', status: 'PASSED' });
    await h.ok('scenario_complete', { runId, code: 'CT-003', status: 'BLOCKED', classification: 'TEST_DATA_FAILURE', reason: 'ainda sem massa' });
    await h.ok('scenario_start', { runId, code: 'CT-001' });
    await h.ok('verify', { kind: 'ui', description: 'título antigo', target: { role: 'heading', name: 'Estudantes' }, timeoutMs: 300 });
    await h.ok('network', {});
    await h.ok('scenario_complete', { runId, code: 'CT-001', status: 'FAILED', classification: 'PRODUCT_BUG', observed: 'título mudou' });
    await h.ok('run_complete', { runId, recommendation: 'REPROVADO', summary: 'regressão no título' });

    const report = await h.ok('report_build', { runId });
    expect(report.summary).toContain(`Retest de ${parent}: corrigidos 1 · ainda falham 0 · regressões 1`);
    const md = readFileSync(join(h.root, report.report), 'utf8');
    expect(md).toContain(`## Comparação com ${parent}`);
    expect(md).toContain('| CT-002 | FAILED | PASSED | corrigido |');
    expect(md).toContain('| CT-003 | BLOCKED | BLOCKED | sem mudança |');
    expect(md).toContain('| CT-001 | PASSED | FAILED | **regressão** |');
  }, 90_000);
});
