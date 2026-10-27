import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { loadConfig } from '../src/config/load.ts';
import { reloadConfig } from '../src/config/runtime.ts';
import { proposeKnowledge } from '../src/knowledge/staging.ts';
import { Redactor } from '../src/security/redact.ts';
import { SecretStore } from '../src/security/secrets.ts';
import { openDb } from '../src/state/db.ts';
import { StateStore, type ScenarioInput } from '../src/state/store.ts';
import { createHarness, PASSWORD, type Harness } from './harness.ts';

const sc = (code: string, risk: ScenarioInput['risk']): ScenarioInput => ({
  code, title: `Cenário ${code}`, priority: 'P2', risk, types: ['functional'], steps: ['passo'], expected: 'resultado',
});

describe('lotes por risco (D4)', () => {
  it('lote encolhe quando entra cenário de risco maior e começa pelo em andamento', () => {
    const config = loadConfig(join(import.meta.dirname, '..'));
    const store = new StateStore(openDb(':memory:'), config);
    const run = store.startRun({ issueKey: 'FIX-1', env: 'fixture-local', mode: 'manual' });
    const plan = [...Array.from({ length: 6 }, (_, i) => sc(`CT-00${i + 1}`, 'LOW')), sc('CT-007', 'HIGH'), sc('CT-008', 'HIGH')];
    store.savePlan(run.id, plan, ['alunos']);
    store.approvePlan(run.id);
    const sizes = { HIGH: 4, MEDIUM: 6, LOW: 8 };

    // Os 6 LOW cabem num lote (8) e o lote para antes do HIGH, em vez de misturar.
    expect(store.nextBatch(run.id, sizes).map((s) => s.code)).toEqual(['CT-001', 'CT-002', 'CT-003', 'CT-004', 'CT-005', 'CT-006']);
    store.startScenario(run.id, 'CT-003');
    expect(store.nextBatch(run.id, sizes)[0]!.code).toBe('CT-003');
    expect(JSON.parse(store.getRun(run.id).modules)).toEqual(['alunos']);

    // HIGH primeiro: o lote inteiro fica no tamanho de HIGH (4).
    const run2 = store.startRun({ issueKey: 'FIX-2', env: 'fixture-local', mode: 'manual' });
    store.savePlan(run2.id, [sc('CT-001', 'HIGH'), ...Array.from({ length: 6 }, (_, i) => sc(`CT-00${i + 2}`, 'LOW'))]);
    store.approvePlan(run2.id);
    expect(store.nextBatch(run2.id, sizes)).toHaveLength(4);
  });
});

describe('proposta de conhecimento', () => {
  let root: string;
  beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'novo-qa-know-')); });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('aceita observação com fonte no run, recusa regra vinda do teste e deduplica', () => {
    const ok = proposeKnowledge(root, 'fixture', 'alunos', 'R1', [
      { statement: 'Salvar aluno com nome "erro" devolve 500', kind: 'regression', status: 'OBSERVED', confidence: 'HIGH', source: { type: 'run', reference: 'R1' } },
      { statement: 'Somente administradores acessam a lista', kind: 'business_rule', status: 'DOCUMENTED', confidence: 'HIGH', source: { type: 'jira', reference: 'FIX-42' } },
    ]);
    expect(ok).toEqual({ file: 'knowledge/fixture/_staging/alunos.yaml', added: 2, duplicates: 0 });
    expect(() => proposeKnowledge(root, 'fixture', 'alunos', 'R1', [
      { statement: 'Nome "erro" não pode ser salvo', kind: 'business_rule', status: 'OBSERVED', confidence: 'HIGH', source: { type: 'run', reference: 'R1' } },
    ])).toThrow(/business_rule exige fonte documental/);
    expect(() => proposeKnowledge(root, 'fixture', 'alunos', 'R1', [
      { statement: 'Lista ordena por nome', kind: 'behavior', status: 'OBSERVED', confidence: 'LOW', source: { type: 'run', reference: 'OUTRO' } },
    ])).toThrow(/run atual/);
    const again = proposeKnowledge(root, 'fixture', 'alunos', 'R1', [
      { statement: 'Salvar aluno com nome "erro" devolve 500', kind: 'regression', status: 'OBSERVED', confidence: 'HIGH', source: { type: 'run', reference: 'R1' } },
    ]);
    expect(again.duplicates).toBe(1);
    const staged = parse(readFileSync(join(root, 'knowledge', 'fixture', '_staging', 'alunos.yaml'), 'utf8'));
    expect(staged).toMatchObject({ module: 'alunos', reviewed: false });
    expect(staged.proposals).toHaveLength(2);
  });
});

describe('config_reload', () => {
  it('ambiente novo e senha nova passam a valer sem reiniciar, e a senha passa a ser redigida', () => {
    const root = mkdtempSync(join(tmpdir(), 'novo-qa-reload-'));
    try {
      cpSync(join(import.meta.dirname, '..', 'config'), join(root, 'config'), { recursive: true });
      const config = loadConfig(root);
      const secrets = SecretStore.fromConfig(config);
      const redactor = new Redactor({ secrets: secrets.valuesForRedaction() });

      const envPath = join(root, 'config', 'environments.yaml');
      writeFileSync(envPath, readFileSync(envPath, 'utf8') + `
  nqa-teste-dev:
    project: guruja
    type: dev
    baseUrl: { env: NQA_TEST_GURUJA_URL }
    allowDataCreation: true
    roles:
      aluno:
        username: aluno.qa@exemplo.com
        password: { env: NQA_TEST_GURUJA_ALUNO_PASSWORD }
`);
      const before = reloadConfig({ rootDir: root, config, secrets, redactor });
      expect(before.environments.find((l) => l.includes('nqa-teste-dev'))).toMatch(/faltam no .env: NQA_TEST_GURUJA_URL, NQA_TEST_GURUJA_ALUNO_PASSWORD/);

      // Sem aspas, o dotenv corta no "#": o reload aponta o problema pelo nome da variável.
      writeFileSync(join(root, '.env'), 'NQA_TEST_GURUJA_URL=https://dev.exemplo.com\nNQA_TEST_GURUJA_ALUNO_PASSWORD=Al#no-Senha-99\n');
      const unquoted = reloadConfig({ rootDir: root, config, secrets, redactor });
      expect(unquoted.dotenvProblem).toMatch(/cortado no #: NQA_TEST_GURUJA_ALUNO_PASSWORD/);
      expect(JSON.stringify(unquoted)).not.toContain('no-Senha');

      writeFileSync(join(root, '.env'), 'NQA_TEST_GURUJA_URL=https://dev.exemplo.com\nNQA_TEST_GURUJA_ALUNO_PASSWORD="Al#no-Senha-99"\n');
      const after = reloadConfig({ rootDir: root, config, secrets, redactor });
      expect(after.dotenvProblem).toBeUndefined();
      expect(after.environments.find((l) => l.includes('nqa-teste-dev'))).toMatch(/^✓/);
      expect(config.environments['nqa-teste-dev']?.type).toBe('dev');
      expect(secrets.resolve('secret:NQA_TEST_GURUJA_ALUNO_PASSWORD')).toBe('Al#no-Senha-99');
      expect(redactor.text('senha digitada: Al#no-Senha-99')).not.toContain('Al#no-Senha-99');
    } finally {
      delete process.env.NQA_TEST_GURUJA_URL;
      delete process.env.NQA_TEST_GURUJA_ALUNO_PASSWORD;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('fluxo /qa ponta a ponta (fixture, ferramentas reais)', () => {
  let h: Harness;
  let runId: string;
  beforeAll(async () => { h = await createHarness(); }, 60_000);
  afterAll(async () => h?.close());

  it('descoberta → plano → lotes → execução → limpeza → conhecimento → relatório', async () => {
    // 1. Descoberta: digest do card e Context Package
    await h.ok('digest_put', {
      source: 'jira', key: 'FIX-50', version: 'v1',
      digest: {
        key: 'FIX-50', title: 'Cadastro de alunos', type: 'Story', status: 'Testing QA', components: ['Alunos'], labels: [],
        summary: 'Admin cadastra aluno pelo nome.', acceptanceCriteria: ['CA01 — aluno salvo aparece na lista', 'CA02 — erro ao salvar mostra mensagem'],
        businessRules: [], roles: ['Administrador'], openQuestions: ['Nome duplicado é permitido?'], links: [], attachments: [], figma: [], confluence: [],
        comments: [], environmentHints: [],
      },
    });
    const ctx = await h.call('context_build', { issueKey: 'FIX-50' });
    expect(ctx.text).toMatch(/key: FIX-50/);

    // 2. Plano com módulo, aprovação
    runId = (await h.ok('run_start', { issueKey: 'FIX-50', env: 'fixture-local', mode: 'manual' })).runId;
    await h.ok('plan_save', {
      runId, modules: ['alunos'],
      scenarios: [
        { code: 'CT-001', title: 'Cadastrar aluno (CA01)', priority: 'P0', risk: 'HIGH', types: ['functional'], steps: ['Novo aluno', 'Nome', 'Salvar'], expected: 'aluno na lista após recarregar' },
        { code: 'CT-002', title: 'Erro ao salvar (CA02)', priority: 'P1', risk: 'MEDIUM', types: ['negative'], steps: ['salvar "erro"'], expected: 'mensagem de erro' },
      ],
    });
    await h.ok('plan_approve', { runId });

    // 3. Briefing do lote: dados do card + cenários, sem copiar o contexto inteiro
    const brief = parse((await h.call('batch_brief', { runId })).text);
    expect(brief.batch.map((s: { code: string }) => s.code)).toEqual(['CT-001', 'CT-002']);
    expect(brief.issue.acceptanceCriteria).toHaveLength(2);
    expect(brief.browser).toEqual({ open: false });

    // 4. Execução (o que o test-executor faria)
    await h.ok('browser_open', { runId, role: 'admin' });
    await h.ok('act', { action: 'fill', target: { label: 'Usuário' }, valueRef: 'role:admin.username' });
    await h.ok('act', { action: 'fill', target: { label: 'Senha' }, valueRef: 'role:admin.password' });
    await h.ok('act', { action: 'click', target: { role: 'button', name: 'Entrar' } });

    await h.ok('scenario_start', { runId, code: 'CT-001' });
    await h.ok('act', { action: 'click', target: { role: 'button', name: 'Novo aluno' } });
    await h.ok('act', { action: 'fill', target: { label: 'Nome' }, value: 'Daniela Reis', valueType: 'studentName' });
    const save = await h.ok('act', { action: 'click', target: { role: 'button', name: 'Salvar' } });
    await h.ok('data_register', {
      runId, id: save.createdData[0].id,
      cleanup: { method: 'api', request: { method: 'DELETE', path: `/api/students/${save.createdData[0].extId}` }, verify: { path: '/api/students', absentText: 'Daniela Reis' } },
    });
    await h.ok('verify', { kind: 'network', description: 'POST criou aluno', method: 'POST', urlContains: '/api/students', status: '201' });
    await h.ok('verify', { kind: 'persistence', description: 'aluno após recarregar', target: { role: 'cell', name: 'Daniela Reis' } });
    await h.ok('scenario_complete', { runId, code: 'CT-001', status: 'PASSED' });

    await h.ok('scenario_start', { runId, code: 'CT-002' });
    await h.ok('act', { action: 'click', target: { role: 'button', name: 'Novo aluno' } });
    await h.ok('act', { action: 'fill', target: { label: 'Nome' }, value: 'erro' });
    await h.ok('act', { action: 'click', target: { role: 'button', name: 'Salvar' } });
    await h.ok('verify', { kind: 'ui', description: 'mensagem amigável de erro', target: { role: 'status' }, condition: 'containsText', text: 'Não foi possível salvar', timeoutMs: 500 });
    await h.ok('network', { urlContains: '/api/students', method: 'POST' });
    await h.ok('scenario_complete', { runId, code: 'CT-002', status: 'FAILED', classification: 'PRODUCT_BUG', observed: 'API devolve 500 e a tela mostra só "Erro ao salvar", sem orientação' });

    expect((await h.ok('batch_brief', { runId })).batch).toEqual([]);

    // 5. Limpeza, 6. conhecimento, 7. fechamento
    expect((await h.ok('cleanup_run', { runId })).results[0].status).toBe('VERIFIED');
    await h.ok('knowledge_propose', {
      runId, module: 'alunos',
      statements: [{ statement: 'POST /api/students devolve 500 para o nome "erro"', kind: 'regression', status: 'OBSERVED', confidence: 'HIGH', source: { type: 'run', reference: runId } }],
    });
    const done = await h.ok('run_complete', { runId, recommendation: 'REPROVADO', summary: 'CA02 violado: erro ao salvar sem mensagem útil.' });
    expect(done.executionKnowledge.merged).toMatchObject({ file: 'knowledge/fixture/execution/alunos.json' });

    const report = await h.ok('report_build', { runId });
    expect(report.summary).toContain('Planned: 2  Executed: 2');
    expect(report.summary).toContain('PASS: 1  FAIL: 1');
    expect(report.summary).toContain('Bugs confirmed: 1');
    expect(report.summary).toContain('Recommendation: REPROVADO');
    const md = readFileSync(join(h.root, report.report), 'utf8');
    expect(md).toMatch(/### CT-002 — Erro ao salvar \(CA02\)/);
    expect(md).toMatch(/Verificação reprovada \(ui\) "mensagem amigável de erro"/);
    expect(md).toMatch(/Evidências: `runs\/FIX-50\/.+\.png` \(screenshot\)/);
    expect(md).toMatch(/Nome duplicado é permitido\?/);
    expect(md).toMatch(/Rascunho de comentário para o Jira \(não publicado\)/);
    expect(md).toMatch(/#1 \/api\/students \(3\): VERIFIED/);
    // Vídeo da sessão: arquivo real, capítulos por cenário e trecho apontado na falha.
    const video = /`(runs\/FIX-50\/[^`]+\.webm)` — CT-001 em \d+:\d{2} · CT-002 em \d+:\d{2}/.exec(md);
    expect(video).not.toBeNull();
    expect(statSync(join(h.root, video![1]!)).size).toBeGreaterThan(10_000);
    expect(md).toMatch(/\.webm` \(video a partir de \d+:\d{2}\)/);

    // HTML sempre gerado: verificações por cenário, miniaturas e vídeo com capítulos clicáveis.
    expect(report.html).toBe(report.report.replace(/\.md$/, '.html'));
    const html = readFileSync(join(h.root, report.html), 'utf8');
    expect(html).toContain('<video id="v0"');
    expect(html).toMatch(/onclick="seek\('v0',\d+\)">▶ CT-002 \d+:\d{2}/);
    expect(html).toContain('mensagem amigável de erro');
    expect(html).toMatch(/<img loading="lazy" src="\.\.\/\.\.\/runs\/FIX-50\//);
    expect(html).not.toContain(PASSWORD);

    // Explicação em linguagem simples: salva no run e mantida ao regerar sem ela.
    await h.ok('report_build', {
      runId,
      explanations: [{ code: 'CT-002', title: 'Salvar com erro não avisa', howToSee: 'Cadastre um aluno com nome "erro"', happens: 'Nada aparece', expected: 'Mensagem de erro' }],
    });
    const again = await h.ok('report_build', { runId });
    expect(readFileSync(join(h.root, again.report), 'utf8')).toMatch(/## Bugs explicados[\s\S]*### 1\. Salvar com erro não avisa \(CT-002\)/);
    expect(readFileSync(join(h.root, again.html), 'utf8')).toContain('<dt>O que acontece</dt><dd>Nada aparece</dd>');

    // Próximo card do módulo já recebe o execution knowledge no briefing
    const next = (await h.ok('run_start', { issueKey: 'FIX-51', env: 'fixture-local', mode: 'manual' })).runId;
    await h.ok('plan_save', { runId: next, modules: ['alunos'], scenarios: [sc('CT-001', 'LOW')] });
    await h.ok('plan_approve', { runId: next });
    const brief2 = parse((await h.call('batch_brief', { runId: next })).text);
    expect(brief2.executionKnowledge).toContain("/students: await page.getByRole('button', { name: 'Salvar' }).click();");
    expect(existsSync(join(h.root, 'knowledge', 'fixture', '_staging', 'alunos.yaml'))).toBe(true);
  }, 120_000);
});
