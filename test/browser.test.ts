import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { unzipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrowserService } from '../src/browser/service.ts';
import { loadConfig } from '../src/config/load.ts';
import { createServer } from '../src/mcp/server.ts';
import { Redactor } from '../src/security/redact.ts';
import { SecretStore } from '../src/security/secrets.ts';
import { openDb, type Db } from '../src/state/db.ts';
import { StateStore } from '../src/state/store.ts';
import { startFixtureServer, type FixtureServer } from './fixture-app/server.ts';

const PASSWORD = 'Fx!segredo-2026';

let fixture: FixtureServer;
let root: string;
let db: Db;
let browser: BrowserService;
let client: Client;
let runId: string;

beforeAll(async () => {
  fixture = await startFixtureServer({ password: PASSWORD });
  root = mkdtempSync(join(tmpdir(), 'novo-qa-browser-'));
  const config = loadConfig(join(import.meta.dirname, '..'));
  config.environments['fixture-local']!.baseUrl = fixture.url;
  const secrets = SecretStore.fromConfig(config, { FIXTURE_ADMIN_PASSWORD: PASSWORD });
  const redactor = new Redactor({ secrets: secrets.valuesForRedaction() });
  db = openDb(':memory:');
  const store = new StateStore(db, config);
  browser = new BrowserService({ rootDir: root, config, store, secrets, redactor });
  const server = createServer({ store, redactor, rootDir: root, browser });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  client = new Client({ name: 'test', version: '0' });
  await client.connect(a);
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await fixture?.close();
  if (root) rmSync(root, { recursive: true, force: true });
});

const transcript: string[] = [];

async function call(name: string, args: Record<string, unknown> = {}) {
  const result = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: ({ type: 'text'; text: string } | { type: 'image'; data: string })[];
  };
  const first = result.content[0] as { text: string };
  transcript.push(JSON.stringify(result.content));
  return {
    isError: result.isError ?? false,
    text: first.text,
    json: result.isError ? undefined : (JSON.parse(first.text) as Record<string, any>),
    content: result.content,
  };
}

async function ok(name: string, args: Record<string, unknown> = {}) {
  const r = await call(name, args);
  if (r.isError) throw new Error(`${name} falhou: ${r.text}`);
  return r.json!;
}

const plan = [
  { code: 'CT-001', title: 'Login com admin', priority: 'P0', risk: 'HIGH', types: ['functional'], steps: ['logar'], expected: 'lista de alunos' },
  { code: 'CT-002', title: 'Cadastrar aluno', priority: 'P0', risk: 'HIGH', types: ['functional'], steps: ['cadastrar'], expected: 'aluno na lista após reload' },
  { code: 'CT-003', title: 'Erro ao salvar', priority: 'P1', risk: 'MEDIUM', types: ['negative'], steps: ['salvar "erro"'], expected: 'mensagem de erro amigável' },
  { code: 'CT-004', title: 'Exclusão exige aprovação', priority: 'P1', risk: 'MEDIUM', types: ['functional'], steps: ['excluir sem e com aprovação'], expected: 'só exclui com aprovação' },
  { code: 'CT-005', title: 'Relatórios sem erros', priority: 'P2', risk: 'LOW', types: ['smoke'], steps: ['abrir relatórios'], expected: 'sem erro de console' },
];

describe('ferramentas de navegador (ponta a ponta no app fixture)', () => {
  it('não abre navegador antes da aprovação do plano', async () => {
    runId = (await ok('run_start', { issueKey: 'FIX-10', env: 'fixture-local', mode: 'manual' })).runId;
    await ok('plan_save', { runId, scenarios: plan });
    const early = await call('browser_open', { runId, role: 'admin' });
    expect(early.isError).toBe(true);
    expect(early.text).toMatch(/plano aprovado/);
    await ok('plan_approve', { runId });
  });

  it('abre, faz login por valueRef e a senha nunca aparece nas respostas', async () => {
    const open = await ok('browser_open', { runId, role: 'admin' });
    expect(open.authReused).toBe(false);
    expect(open.hint).toMatch(/role:admin.password/);
    expect(open.snapshot).toContain('textbox "Usuário"');

    await ok('act', { action: 'fill', target: { label: 'Usuário' }, valueRef: 'role:admin.username' });
    await ok('act', { action: 'fill', target: { label: 'Senha' }, valueRef: 'role:admin.password' });
    const login = await ok('act', { action: 'click', target: { role: 'button', name: 'Entrar' } });
    expect(login.url).toMatch(/\/students$/);
    expect(login.requests.some((r: string) => r.includes('POST /api/login → 200'))).toBe(true);
    expect(login.changes.added.some((l: string) => l.includes('heading "Alunos"'))).toBe(true);

    const detail = await ok('network', { urlContains: '/api/login' });
    const id = Number(/#(\d+)/.exec(detail.requests[0])![1]);
    const full = await ok('network', { id });
    expect(JSON.stringify(full)).not.toContain(PASSWORD);
    expect(full.requestBody).toContain('[REDACTED');
    // headers() do Playwright já omite set-cookie; se um dia vier, tem de vir redigido.
    expect(full.responseHeaders['set-cookie'] ?? '[REDACTED]').toBe('[REDACTED]');

    await ok('browser_save_auth');
    expect(existsSync(join(root, '.auth', 'fixture-local-admin.json'))).toBe(true);
  }, 60_000);

  it('CT-001: verificações registradas pelo código', async () => {
    await ok('scenario_start', { runId, code: 'CT-001' });
    expect((await ok('verify', { kind: 'url', description: 'redirecionou para alunos', urlPattern: '/students' })).passed).toBe(true);
    const heading = await ok('verify', { kind: 'ui', description: 'título Alunos', target: { role: 'heading', name: 'Alunos' } });
    expect(heading).toMatchObject({ passed: true, actual: 'visível' });
    const done = await ok('scenario_complete', { runId, code: 'CT-001', status: 'PASSED' });
    expect(done).toMatchObject({ status: 'PASSED', confidence: 'MEDIUM' });
  }, 60_000);

  it('CT-002: escrita em P0 exige verificação forte; alvos ambíguos pedem refinamento', async () => {
    await ok('scenario_start', { runId, code: 'CT-002' });
    expect((await ok('act', { action: 'click', target: { role: 'button', name: 'Novo aluno' } })).level).toBe('YELLOW');
    await ok('act', { action: 'fill', target: { label: 'Nome' }, value: 'Carla Dias', valueType: 'studentName' });
    const save = await ok('act', { action: 'click', target: { role: 'button', name: 'Salvar' } });
    expect(save.level).toBe('YELLOW');
    expect(save.requests.some((r: string) => r.includes('POST /api/students → 201'))).toBe(true);
    expect(save.createdData).toEqual([{ id: 1, resource: '/api/students', extId: '3' }]);

    const toast = await ok('verify', { kind: 'ui', description: 'mensagem de sucesso', target: { role: 'status' }, condition: 'containsText', text: 'Aluno salvo' });
    expect(toast).toMatchObject({ passed: true });
    const weak = await call('scenario_complete', { runId, code: 'CT-002', status: 'PASSED' });
    expect(weak.isError).toBe(true);
    expect(weak.text).toMatch(/verificação forte/);

    await ok('verify', { kind: 'network', description: 'POST de aluno criado', method: 'POST', urlContains: '/api/students', status: '201', bodyContains: 'Carla Dias' });
    const sent = await ok('verify', { kind: 'network', description: 'POST enviou o nome digitado', method: 'POST', urlContains: '/api/students', status: '201', requestBodyContains: '"name":"Carla Dias"' });
    expect(sent.actual).toContain('enviado: {"name":"Carla Dias"}');
    const persisted = await ok('verify', { kind: 'persistence', description: 'aluno após reload', target: { role: 'cell', name: 'Carla Dias' } });
    expect(persisted.passed).toBe(true);

    const ambiguous = await call('act', { action: 'click', target: { role: 'button', name: 'Editar' } });
    expect(ambiguous.isError).toBe(true);
    expect(ambiguous.text).toMatch(/3 elementos[\s\S]*Carla Dias/);
    const refined = await ok('act', { action: 'click', target: { role: 'button', name: 'Editar', within: { role: 'row', name: 'Carla Dias' } } });
    expect(refined.ok).toBe(true);

    expect(await ok('scenario_complete', { runId, code: 'CT-002', status: 'PASSED' })).toMatchObject({ confidence: 'HIGH' });
  }, 60_000);

  it('CT-003: falha gera evidência; PRODUCT_BUG só depois de investigar; trace sanitizado', async () => {
    await ok('scenario_start', { runId, code: 'CT-003' });
    await ok('act', { action: 'click', target: { role: 'button', name: 'Novo aluno' } });
    // Segredo digitado dentro de um cenário que vai falhar: o trace.zip guardado não pode contê-lo.
    await ok('act', { action: 'fill', target: { label: 'Nome' }, valueRef: 'role:admin.password' });
    await ok('act', { action: 'fill', target: { label: 'Nome' }, value: 'erro' });
    const save = await ok('act', { action: 'click', target: { role: 'button', name: 'Salvar' } });
    expect(save.consoleErrors.some((e: string) => /falha ao salvar aluno: 500/.test(e))).toBe(true);

    const check = await ok('verify', { kind: 'network', description: 'aluno criado', method: 'POST', urlContains: '/api/students', status: '201', timeoutMs: 500 });
    expect(check.passed).toBe(false);
    expect(check.actual).toMatch(/→ 500/);
    expect(existsSync(join(root, check.evidence))).toBe(true);

    const premature = await call('scenario_complete', { runId, code: 'CT-003', status: 'FAILED', classification: 'PRODUCT_BUG', observed: 'API 500' });
    expect(premature.text).toMatch(/PRODUCT_BUG exige investigação/);

    const errors = await ok('console', { errorsOnly: true });
    expect(errors.messages.some((m: string) => /falha ao salvar aluno/.test(m))).toBe(true);
    const failed = await ok('scenario_complete', { runId, code: 'CT-003', status: 'FAILED', classification: 'PRODUCT_BUG', observed: 'POST /api/students devolve 500 com nome "erro"' });
    expect(failed).toMatchObject({ status: 'FAILED', confidence: 'MEDIUM' });

    const trace = join(root, 'runs', 'FIX-10', runId, 'evidence', 'CT-003-trace.zip');
    expect(existsSync(trace)).toBe(true);

    // A resposta 500 virou evidência em arquivo, com o corpo (antes só existia em memória).
    const httpError = db.prepare(`SELECT path, meta FROM evidence WHERE kind = 'http-error' AND path LIKE '%CT-003-http-500-%'`).get() as { path: string; meta: string };
    expect(JSON.parse(httpError.meta)).toMatchObject({ status: 500, method: 'POST', path: '/api/students' });
    const saved = readFileSync(join(root, httpError.path), 'utf8');
    expect(saved).toMatch(/^POST http:\/\/localhost:\d+\/api\/students\nstatus: 500/);
    expect(saved).toContain('{"error":"falha interna"}');
    expect(saved).toContain('[REDACTED'); // cookie/headers sensíveis mascarados
  }, 60_000);

  it('CT-004: exclusão sem aprovação é bloqueada; com aprovação remove o aluno criado no teste', async () => {
    await ok('scenario_start', { runId, code: 'CT-004' });
    const blocked = await call('act', { action: 'click', target: { role: 'button', name: 'Excluir', within: { role: 'row', name: 'Bruno Lima' } } });
    expect(blocked.text).toMatch(/RED[\s\S]*act_approved/);
    await ok('verify', { kind: 'api', description: 'Bruno continua no servidor', path: '/api/students', bodyContains: 'Bruno Lima' });

    const del = await ok('act_approved', {
      action: 'click', dialog: 'accept', justification: 'remover o aluno criado pelo próprio teste (CT-002)',
      target: { role: 'button', name: 'Excluir', within: { role: 'row', name: 'Carla Dias' } },
    });
    expect(del.dialogs[0]).toMatch(/confirm "Excluir este aluno\?" → accept/);
    await ok('verify', { kind: 'ui', description: 'Carla fora da lista', target: { role: 'cell', name: 'Carla Dias' }, condition: 'hidden' });
    // api (forte) + ui (fraca), sem erro de console → HIGH
    expect(await ok('scenario_complete', { runId, code: 'CT-004', status: 'PASSED' })).toMatchObject({ confidence: 'HIGH' });
  }, 60_000);

  it('CT-005: erro de console vira verificação reprovada; screenshot com view devolve imagem', async () => {
    await ok('scenario_start', { runId, code: 'CT-005' });
    const nav = await ok('navigate', { url: '/reports' });
    expect(nav.snapshot).toContain('heading "Relatórios"');
    const consoleCheck = await ok('verify', { kind: 'console', description: 'sem erros no relatório' });
    expect(consoleCheck.passed).toBe(false);
    expect(consoleCheck.actual).toMatch(/falha ao carregar relatório/);

    const shot = await call('screenshot', { view: true, label: 'relatorio' });
    expect(shot.content[1]).toMatchObject({ type: 'image' });
    const quiet = await ok('screenshot', { label: 'sem-view' });
    expect(quiet.path).toMatch(/CT-005-.*sem-view\.png$/);

    await ok('scenario_complete', { runId, code: 'CT-005', status: 'NEEDS_REVIEW', reason: 'erro de console sem impacto visível' });
  }, 60_000);

  it('conclusão exige limpeza verificada e grava execution knowledge validado', async () => {
    expect((await call('run_complete', { runId, recommendation: 'REPROVADO', summary: 'tentativa' })).text).toMatch(/UNREGISTERED/);
    await ok('data_register', {
      runId, id: 1,
      cleanup: { method: 'manual', note: 'excluído pela UI no CT-004 (act_approved)', verify: { path: '/api/students', absentText: 'Carla Dias' } },
    });
    expect((await ok('cleanup_run', { runId })).results[0].status).toBe('VERIFIED');

    const done = await ok('run_complete', { runId, recommendation: 'REPROVADO', summary: '1 bug confirmado' });
    expect(done.executionKnowledge.entries).toBeGreaterThan(0);
    const entries = JSON.parse(readFileSync(join(root, done.executionKnowledge.path), 'utf8')) as { playwright: string; scenario: string; valueType?: string }[];
    const lines = entries.map((e) => e.playwright);
    expect(lines).toContain("await page.getByLabel('Senha').fill(<password>);");
    expect(lines).toContain("await page.getByRole('button', { name: 'Salvar' }).click();");
    expect(lines).toContain("await page.getByLabel('Nome').fill(<studentName>);");
    expect(lines).toContain("await page.getByRole('row', { name: 'Carla Dias' }).getByRole('button', { name: 'Excluir' }).click();");
    // Ação bloqueada pelo guard não é conhecimento de execução.
    expect(lines.some((l) => l.includes("'Bruno Lima'"))).toBe(false);
    // "Editar" foi clicado sem nenhuma verificação depois: não é conhecimento validado (D1).
    expect(lines.some((l) => l.includes("'Editar'"))).toBe(false);
    expect(entries.find((e) => e.playwright.includes('Senha'))?.scenario).toBe('(setup)');
  }, 60_000);

  it('a senha não aparece em nenhum artefato, banco ou resposta', () => {
    const leaks: string[] = [];
    const scan = (label: string, text: string) => {
      if (text.includes(PASSWORD) || text.includes(encodeURIComponent(PASSWORD))) leaks.push(label);
    };
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (name.endsWith('.zip')) {
          for (const [entry, data] of Object.entries(unzipSync(readFileSync(path)))) scan(`${name}:${entry}`, Buffer.from(data).toString('latin1'));
        } else scan(path, readFileSync(path).toString('latin1'));
      }
    };
    walk(root);
    for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]) {
      scan(`db:${name}`, JSON.stringify(db.prepare(`SELECT * FROM ${name}`).all()));
    }
    transcript.forEach((t, i) => scan(`resposta ${i}`, t));
    expect(leaks).toEqual([]);
  });
});
