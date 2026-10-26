import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, loggedInRun, type Harness } from './harness.ts';

describe('Action Guard em ambiente local (permite dados)', () => {
  let h: Harness;
  let runId: string;
  beforeAll(async () => {
    h = await createHarness();
    runId = await loggedInRun(h, 'FIX-20', ['CT-001', 'CT-002', 'CT-003', 'CT-004']);
  }, 60_000);
  afterAll(async () => h?.close());

  it('RED sem aprovação é bloqueado antes de agir', async () => {
    await h.ok('scenario_start', { runId, code: 'CT-001' });
    const del = await h.call('act', { action: 'click', target: { role: 'button', name: 'Excluir', within: { role: 'row', name: 'Ana Souza' } } });
    expect(del.isError).toBe(true);
    expect(del.text).toMatch(/bloqueado \(RED: alvo contém "excluir"\)[\s\S]*act_approved/);
    await h.ok('verify', { kind: 'ui', description: 'Ana continua', target: { role: 'cell', name: 'Ana Souza' } });
    const row = h.db.prepare("SELECT ok, error, guard_level FROM actions WHERE error LIKE 'BLOQUEADO%'").get();
    expect(row).toMatchObject({ ok: 0, guard_level: 'RED' });
    await h.ok('scenario_complete', { runId, code: 'CT-001', status: 'PASSED' });
  }, 60_000);

  it('RED aprovado executa, aceita a confirmação, libera o DELETE e registra a aprovação', async () => {
    await h.ok('scenario_start', { runId, code: 'CT-002' });
    const del = await h.ok('act_approved', {
      action: 'click', dialog: 'accept', justification: 'usuário aprovou excluir Ana Souza para testar exclusão',
      target: { role: 'button', name: 'Excluir', within: { role: 'row', name: 'Ana Souza' } },
    });
    expect(del.level).toBe('RED');
    expect(del.dialogs[0]).toMatch(/→ accept$/);
    expect(del.requests.some((r: string) => /DELETE \/api\/students\/1 → 204/.test(r))).toBe(true);
    await h.ok('verify', { kind: 'api', description: 'Ana removida no servidor', path: '/api/students', bodyContains: 'Bruno Lima' });
    await h.ok('verify', { kind: 'ui', description: 'Ana fora da lista', target: { role: 'cell', name: 'Ana Souza' }, condition: 'hidden' });
    const approval = h.db.prepare("SELECT level, decision FROM approvals WHERE action = 'click'").get() as { level: string; decision: string };
    expect(approval.level).toBe('RED');
    expect(approval.decision).toMatch(/^APPROVED: usuário aprovou/);
    await h.ok('scenario_complete', { runId, code: 'CT-002', status: 'PASSED' });
    h.fixture.reset();
  }, 60_000);

  it('rede de segurança: DELETE disparado por botão "inofensivo" é barrado', async () => {
    await h.ok('scenario_start', { runId, code: 'CT-003' });
    await h.ok('navigate', { url: '/students', snapshot: false });
    const clear = await h.ok('act', { action: 'click', target: { role: 'button', name: 'Limpar filtros' } });
    expect(clear.level).toBe('GREEN');
    expect(clear.blockedRequests).toEqual(['DELETE /api/students/1 (bloqueado pelo guard)']);
    await h.ok('verify', { kind: 'api', description: 'Ana não foi excluída', path: '/api/students', bodyContains: 'Ana Souza' });
    // Atributo (ex.: href de link externo) verificado sem abrir o destino.
    const href = await h.ok('verify', { kind: 'ui', description: 'link de relatórios aponta para /reports', target: { role: 'link', name: 'Relatórios' }, condition: 'attribute', attribute: 'href', text: '/reports' });
    expect(href).toMatchObject({ passed: true, actual: 'href="/reports"' });
    const wrong = await h.ok('verify', { kind: 'ui', description: 'link aponta para mailto', target: { role: 'link', name: 'Relatórios' }, condition: 'attribute', attribute: 'href', text: 'mailto:', timeoutMs: 300 });
    expect(wrong.passed).toBe(false);
    await h.ok('verify', { kind: 'ui', description: 'link aponta para mailto', target: { role: 'link', name: 'Relatórios' }, condition: 'attribute', attribute: 'href', text: '/reports' });
    // Evidência objetiva de que algo tentou excluir: é um achado de QA, não só um bloqueio.
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'guard.network_block'").get()).toEqual({ n: 1 });
    await h.ok('scenario_complete', { runId, code: 'CT-003', status: 'PASSED' });
  }, 60_000);

  it('confirmação destrutiva não é aceita por act comum; botão só com ícone é YELLOW', async () => {
    await h.ok('scenario_start', { runId, code: 'CT-004' });
    const archive = await h.ok('act', { action: 'click', dialog: 'accept', target: { role: 'button', name: 'Arquivar antigos' } });
    expect(archive.dialogs[0]).toMatch(/→ dismiss \(BLOQUEADO: confirmação destrutiva exige act_approved\)/);
    await h.ok('verify', { kind: 'api', description: 'Bruno não foi excluído', path: '/api/students', bodyContains: 'Bruno Lima' });

    const icon = await h.ok('act', { action: 'click', target: { role: 'button', name: '🗑' } });
    expect(icon).toMatchObject({ level: 'YELLOW', levelReason: 'alvo sem texto legível: efeito desconhecido' });
    await h.ok('scenario_complete', { runId, code: 'CT-004', status: 'PASSED' });
  }, 60_000);
});

describe('condições de teste: simulação de rede e responsivo', () => {
  let h: Harness;
  afterEach(async () => h?.close());

  it('simula 500 só no navegador (servidor intacto), mede a reação da tela e limpa ao fim do cenário', async () => {
    h = await createHarness();
    const runId = await loggedInRun(h, 'FIX-30', ['CT-001', 'CT-002']);
    expect((await h.call('network_simulate', { urlContains: '/api/students', status: 500 })).text).toMatch(/dentro de um cenário/);

    await h.ok('scenario_start', { runId, code: 'CT-001' });
    const sim = await h.ok('network_simulate', { urlContains: '/api/students', method: 'POST', status: 500, times: 1 });
    expect(sim.active[0]).toMatch(/POST \*\/api\/students\* → status 500/);
    await h.ok('act', { action: 'click', target: { role: 'button', name: 'Novo aluno' } });
    await h.ok('act', { action: 'fill', target: { label: 'Nome' }, value: 'Simulado' });
    await h.ok('act', { action: 'click', target: { role: 'button', name: 'Salvar' } });
    await h.ok('verify', { kind: 'ui', description: 'tela trata erro do servidor', target: { role: 'status' }, condition: 'containsText', text: 'Erro ao salvar' });
    // O servidor não recebeu nada: o aluno não existe.
    await h.ok('verify', { kind: 'api', description: 'nada gravado no servidor', path: '/api/students', bodyContains: 'Ana Souza' });
    expect(JSON.stringify((await h.ok('verify', { kind: 'api', description: 'Simulado ausente', path: '/api/students' })).actual)).not.toContain('Simulado');

    // times: 1 → a segunda tentativa vai ao servidor de verdade
    await h.ok('act', { action: 'click', target: { role: 'button', name: 'Novo aluno' } });
    await h.ok('act', { action: 'fill', target: { label: 'Nome' }, value: 'Real depois da simulação' });
    const real = await h.ok('act', { action: 'click', target: { role: 'button', name: 'Salvar' } });
    expect(real.requests.some((r: string) => /POST \/api\/students → 201/.test(r))).toBe(true);
    await h.ok('data_register', { runId, id: real.createdData[0].id, cleanup: { method: 'keep', reason: 'aluno criado no teste de simulação' } });
    await h.ok('scenario_complete', { runId, code: 'CT-001', status: 'PASSED' });

    // Simulação de CT-001 não vaza para CT-002
    await h.ok('scenario_start', { runId, code: 'CT-002' });
    await h.ok('network_simulate', { urlContains: '/api/students', method: 'GET', status: 500 });
    await h.ok('scenario_complete', { runId, code: 'CT-002', status: 'NOT_EXECUTED', reason: 'só testa limpeza da simulação' });
    expect((await h.ok('network_simulate_clear')).cleared).toEqual([]);
  }, 90_000);

  it('viewport mobile redimensiona a janela (screenshot com a largura nova)', async () => {
    h = await createHarness();
    const runId = await loggedInRun(h, 'FIX-31', ['CT-001']);
    await h.ok('scenario_start', { runId, code: 'CT-001' });
    expect(await h.ok('browser_viewport', { preset: 'mobile' })).toMatchObject({ viewport: { width: 390, height: 844 }, preset: 'mobile' });
    const shot = await h.ok('screenshot', { label: 'mobile' });
    const png = readFileSync(join(h.root, shot.path));
    expect(png.readUInt32BE(16)).toBe(390); // largura no cabeçalho IHDR do PNG
    expect((await h.call('browser_viewport', {})).text).toMatch(/preset/);
  }, 60_000);
});

describe('limpeza de dados criados', () => {
  let h: Harness;
  afterEach(async () => h?.close());

  it('criação é detectada, bloqueia o fim do run e só libera após limpeza verificada', async () => {
    h = await createHarness();
    const runId = await loggedInRun(h, 'FIX-21', ['CT-001']);
    await h.ok('scenario_start', { runId, code: 'CT-001' });
    await h.ok('act', { action: 'click', target: { role: 'button', name: 'Novo aluno' } });
    await h.ok('act', { action: 'fill', target: { label: 'Nome' }, value: 'Teste NOVO_QA', valueType: 'studentName' });
    const save = await h.ok('act', { action: 'click', target: { role: 'button', name: 'Salvar' } });
    expect(save.createdData).toEqual([{ id: 1, resource: '/api/students', extId: '3' }]);
    expect(save.cleanupHint).toMatch(/data_register/);
    await h.ok('verify', { kind: 'persistence', description: 'aluno após reload', target: { role: 'cell', name: 'Teste NOVO_QA' } });
    await h.ok('scenario_complete', { runId, code: 'CT-001', status: 'PASSED' });

    const blocked = await h.call('run_complete', { runId, recommendation: 'APROVADO', summary: 'tudo certo' });
    expect(blocked.text).toMatch(/#1 \/api\/students \(3\): UNREGISTERED/);

    const bad = await h.call('data_register', { runId, id: 1, cleanup: { method: 'api', request: { method: 'DELETE', path: '/api/students/3' } } });
    expect(bad.isError).toBe(true); // sem verify

    await h.ok('data_register', {
      runId, id: 1,
      cleanup: { method: 'api', request: { method: 'DELETE', path: '/api/students/3' }, verify: { path: '/api/students', absentText: 'Teste NOVO_QA' } },
    });
    const cleanup = await h.ok('cleanup_run', { runId });
    expect(cleanup.results).toEqual([
      { id: 1, resource: '/api/students', status: 'VERIFIED', detail: 'DELETE /api/students/3 → 204; verificação GET /api/students → 200' },
    ]);
    expect((await h.ok('run_complete', { runId, recommendation: 'APROVADO', summary: 'tudo certo' })).status).toBe('COMPLETED');
  }, 60_000);

  it('limpeza que não se confirma fica FAILED e continua bloqueando', async () => {
    h = await createHarness();
    const runId = await loggedInRun(h, 'FIX-22', ['CT-001']);
    await h.ok('data_register', {
      runId, resource: '/api/students', extId: '1',
      cleanup: { method: 'manual', note: 'supostamente excluído pela UI', verify: { path: '/api/students', absentText: 'Ana Souza' } },
    });
    const cleanup = await h.ok('cleanup_run', { runId });
    expect(cleanup.results[0]).toMatchObject({ status: 'FAILED' });
    expect(cleanup.results[0].detail).toMatch(/ainda contém "Ana Souza"/);
    await h.ok('scenario_start', { runId, code: 'CT-001' });
    await h.ok('scenario_complete', { runId, code: 'CT-001', status: 'NOT_EXECUTED', reason: 'teste de limpeza' });
    expect((await h.call('run_complete', { runId, recommendation: 'INCONCLUSIVO', summary: 'limpeza falhou' })).text).toMatch(/FAILED/);
  }, 60_000);
});

describe('ambientes restritivos', () => {
  let h: Harness;
  afterEach(async () => h?.close());

  it('prod: só GREEN — criar é bloqueado, ler e preencher não', async () => {
    h = await createHarness({ type: 'prod' });
    const runId = await loggedInRun(h, 'FIX-23', ['CT-001']);
    await h.ok('scenario_start', { runId, code: 'CT-001' });
    const create = await h.call('act', { action: 'click', target: { role: 'button', name: 'Novo aluno' } });
    expect(create.text).toMatch(/ação YELLOW não é permitida em ambiente prod/);
    await h.ok('act', { action: 'fill', target: { placeholder: 'Buscar aluno' }, value: 'Ana' });
    const red = await h.call('act_approved', {
      action: 'click', justification: 'mesmo aprovado, prod não permite', target: { role: 'button', name: 'Excluir', within: { role: 'row', name: 'Ana Souza' } },
    });
    expect(red.text).toMatch(/ação RED não é permitida em ambiente prod/);
  }, 60_000);

  it('allowDataCreation: false bloqueia YELLOW', async () => {
    h = await createHarness({ allowDataCreation: false });
    const runId = await loggedInRun(h, 'FIX-24', ['CT-001']);
    await h.ok('scenario_start', { runId, code: 'CT-001' });
    const create = await h.call('act', { action: 'click', target: { role: 'button', name: 'Novo aluno' } });
    expect(create.text).toMatch(/não permite criar\/alterar dados/);
    // Sem nada a limpar, cleanup_run responde sem exigir permissão de escrita (nem navegador aberto).
    await h.ok('browser_close');
    expect(await h.ok('cleanup_run', { runId })).toEqual({ results: [], nothingToClean: true });
  }, 60_000);
});
