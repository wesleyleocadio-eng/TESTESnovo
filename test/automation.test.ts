import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseReport } from '../src/automation/runner.ts';
import { assessSuitability } from '../src/automation/suitability.ts';
import { assertionFor } from '../src/automation/spec.ts';
import { createHarness, loggedInRun, PASSWORD, type Harness } from './harness.ts';

const good = { stable: 'yes', repeatable: 'yes', externalDeps: 'none', humanStep: false, visual: false, regressionValue: 'high' } as const;

describe('suitability (rubrica)', () => {
  const passed = { status: 'PASSED', confidence: 'HIGH', validatedActions: 4 };
  it('cenário estável e repetível é HIGH; passo humano derruba para LOW', () => {
    expect(assessSuitability(good, passed)).toMatchObject({ score: 100, level: 'HIGH', automate: true });
    expect(assessSuitability({ ...good, humanStep: true }, passed)).toMatchObject({ score: 50, level: 'MEDIUM', automate: false });
    expect(assessSuitability({ ...good, humanStep: true, visual: true }, passed)).toMatchObject({ level: 'LOW', automate: false });
  });
  it('MEDIUM só entra com motivo; não-PASSED nunca entra', () => {
    const medium = { ...good, repeatable: 'partial', regressionValue: 'medium' } as const;
    expect(assessSuitability(medium, passed)).toMatchObject({ score: 75, level: 'MEDIUM', automate: false });
    expect(assessSuitability(medium, passed, { reason: 'fluxo crítico de cadastro' }).automate).toBe(true);
    expect(assessSuitability(good, { ...passed, status: 'FAILED' })).toMatchObject({ score: 0, automate: false });
  });
  it('sem ações validadas no manual perde pontos (seletores a redescobrir)', () => {
    expect(assessSuitability(good, { ...passed, validatedActions: 0 }).score).toBe(80);
  });
});

describe('assertions derivadas das verificações manuais', () => {
  it('mapeia cada tipo de verificação', () => {
    expect(assertionFor('ui', { kind: 'ui', description: 'x', target: { role: 'cell', name: 'Ana' } })).toBe("await expect(page.getByRole('cell', { name: 'Ana' })).toBeVisible();");
    expect(assertionFor('ui', { kind: 'ui', description: 'x', target: { role: 'status' }, condition: 'containsText', text: 'Aluno salvo' })).toBe("await expect(page.getByRole('status')).toContainText('Aluno salvo');");
    expect(assertionFor('persistence', { kind: 'persistence', description: 'x', target: { role: 'cell', name: 'Ana' } })).toBe("await page.reload(); await expect(page.getByRole('cell', { name: 'Ana' })).toBeVisible();");
    expect(assertionFor('url', { kind: 'url', description: 'x', urlPattern: '/students' })).toBe("await expect(page).toHaveURL(new RegExp('/students'));");
    expect(assertionFor('ui', { kind: 'ui', description: 'x', target: { role: 'link', name: 'WhatsApp' }, condition: 'attribute', attribute: 'href', text: 'wa.me/55' })).toBe(
      "await expect(page.getByRole('link', { name: 'WhatsApp' })).toHaveAttribute('href', new RegExp('wa\\\\.me/55'));",
    );
    expect(assertionFor('api', { kind: 'api', description: 'x', path: '/api/students', bodyContains: 'Ana' })).toBe("const res = await page.request.get('/api/students'); expect(res.ok()).toBeTruthy(); expect(await res.text()).toContain('Ana');");
    expect(assertionFor('network', { kind: 'network', description: 'x', method: 'POST', urlContains: '/api/students', status: '201' })).toMatch(/waitForResponse.*expect\(res\.status\(\)\)\.toBe\(201\)/);
  });
});

describe('relatório do Playwright', () => {
  it('repetições com resultado diferente são flaky; erros e bloqueios do guard aparecem', () => {
    const spec = (title: string, statuses: ('expected' | 'unexpected' | 'flaky' | 'skipped')[], annotations: { type: string; description?: string }[] = []) => ({
      title, file: 'FIX-1/a.spec.ts',
      tests: statuses.map((status) => ({ status, annotations, results: [{ status: status === 'expected' ? 'passed' : 'failed', duration: 10, ...(status === 'unexpected' ? { error: { message: '\u001b[31mTimeout 5000ms\u001b[39m\n  at x' } } : {}) }] })),
    });
    const parsed = parseReport({
      suites: [{ suites: [{ specs: [spec('CT-001 — ok', ['expected', 'expected']), spec('CT-002 — instável', ['expected', 'unexpected']), spec('CT-003 — quebra', ['unexpected', 'unexpected'], [{ type: 'novo-qa-blocked', description: 'DELETE /api/students/1' }]), spec('sem código', ['skipped'])] }] }],
    });
    expect(parsed.tests.map((t) => [t.scenario, t.status, t.attempts])).toEqual([
      ['CT-001', 'passed', 2], ['CT-002', 'flaky', 2], ['CT-003', 'failed', 2], [null, 'skipped', 1],
    ]);
    expect(parsed.tests[2]).toMatchObject({ error: 'Timeout 5000ms\n  at x', blocked: ['DELETE /api/students/1'] });
  });
});

describe('automação ponta a ponta: manual → assess → AUTOMATION.md → spec → executa → corrige → valida', () => {
  let h: Harness;
  let runId: string;
  beforeAll(async () => {
    h = await createHarness();
    h.config.policy.automation.maxFixAttempts = 1; // limite = 2 tentativas
    // A suíte roda no diretório temporário: precisa das dependências do repositório e de um package.json próprio.
    symlinkSync(join(import.meta.dirname, '..', 'node_modules'), join(h.root, 'node_modules'), 'junction');
    writeFileSync(join(h.root, 'package.json'), '{ "type": "module" }\n');
    process.env.FIXTURE_ADMIN_PASSWORD = PASSWORD;
  }, 60_000);
  afterAll(async () => {
    delete process.env.FIXTURE_ADMIN_PASSWORD;
    await h?.close();
  });

  it('teste manual que alimenta a automação', async () => {
    runId = await loggedInRun(h, 'FIX-90', ['CT-001', 'CT-002']);
    await h.ok('scenario_start', { runId, code: 'CT-001' });
    await h.ok('act', { action: 'click', target: { role: 'button', name: 'Novo aluno' } });
    await h.ok('act', { action: 'fill', target: { label: 'Nome' }, value: 'Elisa Prado', valueType: 'studentName' });
    const save = await h.ok('act', { action: 'click', target: { role: 'button', name: 'Salvar' } });
    await h.ok('data_register', {
      runId, id: save.createdData[0].id,
      cleanup: { method: 'api', request: { method: 'DELETE', path: `/api/students/${save.createdData[0].extId}` }, verify: { path: '/api/students', absentText: 'Elisa Prado' } },
    });
    await h.ok('verify', { kind: 'ui', description: 'mensagem de sucesso', target: { role: 'status' }, condition: 'containsText', text: 'Aluno salvo' });
    await h.ok('verify', { kind: 'persistence', description: 'aluno após recarregar', target: { role: 'cell', name: 'Elisa Prado' } });
    await h.ok('scenario_complete', { runId, code: 'CT-001', status: 'PASSED' });
    await h.ok('scenario_complete', { runId, code: 'CT-002', status: 'NOT_EXECUTED', reason: 'fora do escopo do teste' });
    await h.ok('cleanup_run', { runId });

    expect((await h.call('automation_assess', { runId, assessments: [{ code: 'CT-001', factors: good }] })).text).toMatch(/run está EXECUTING/);
    await h.ok('run_complete', { runId, recommendation: 'APROVADO', summary: 'cadastro ok' });
  }, 60_000);

  it('assess + spec geram AUTOMATION.md a partir do que foi executado e verificado', async () => {
    const assessed = await h.ok('automation_assess', {
      runId,
      assessments: [{ code: 'CT-001', factors: good }, { code: 'CT-002', factors: good }],
    });
    expect(assessed.assessed[0]).toMatch(/^CT-001 100 HIGH → automatizar/);
    expect(assessed.assessed[1]).toMatch(/^CT-002 0 LOW → fora/);

    const spec = await h.ok('automation_spec', { runId });
    expect(spec.scenarios).toEqual(['CT-001']);
    expect(spec.scaffolded).toEqual(expect.arrayContaining(['automation/fixture/env.ts', 'automation/fixture/playwright.config.ts', 'automation/fixture/fixtures/index.ts']));
    const md = readFileSync(join(h.root, 'automation/fixture/specs/FIX-90/AUTOMATION.md'), 'utf8');
    expect(md).toContain("await page.getByLabel('Senha').fill(<password>);  // credentials(role).password");
    expect(md).toContain("await page.getByLabel('Nome').fill(<studentName>);");
    expect(md).toContain("await expect(page.getByRole('status')).toContainText('Aluno salvo');");
    expect(md).toContain("await page.reload(); await expect(page.getByRole('cell', { name: 'Elisa Prado' })).toBeVisible();");
    expect(md).toContain('DELETE /api/students/<id criado>');
    expect(md).toMatch(/## Fora da automação[\s\S]*CT-002/);
    expect(md).not.toContain(PASSWORD);
    expect(JSON.parse(readFileSync(join(h.root, 'automation/fixture/specs/FIX-90/test-data.json'), 'utf8'))).toEqual({ studentName: { sample: 'Elisa Prado', usedIn: ['CT-001'] } });
    expect(readFileSync(join(h.root, 'automation/fixture/env.ts'), 'utf8')).toContain("password: { env: 'FIXTURE_ADMIN_PASSWORD' }");
  });

  it('falha de automação é corrigida dentro do limite; validação 2× entrega', async () => {
    const dir = join(h.root, 'automation/fixture/tests/FIX-90');
    mkdirSync(dir, { recursive: true });
    const specFile = (nameLabel: string) => `import { test, expect, unique } from '../../fixtures/index.ts';
import { credentials } from '../../env.ts';

test('CT-001 — cadastrar aluno', async ({ page }) => {
  const nome = unique('NOVO_QA');
  const { username, password } = credentials('admin');
  await page.goto('/');
  await page.getByLabel('Usuário').fill(username);
  await page.getByLabel('Senha').fill(password);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await page.getByRole('button', { name: 'Novo aluno' }).click();
  await page.getByLabel('${nameLabel}').fill(nome);
  const resP = page.waitForResponse((r) => r.url().includes('/api/students') && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Salvar' }).click();
  const res = await resP;
  expect(res.status()).toBe(201);
  const { id } = await res.json();
  await expect(page.getByRole('status')).toContainText('Aluno salvo');
  await page.reload();
  await expect(page.getByRole('cell', { name: nome })).toBeVisible();
  // guard da automação: botão que dispara DELETE escondido não apaga nada
  await page.getByRole('button', { name: 'Limpar filtros' }).click();
  await expect(page.getByRole('cell', { name: 'Ana Souza' })).toBeVisible();
  // limpeza (request não passa pelo guard da página)
  expect((await page.request.delete(\`/api/students/\${id}\`)).ok()).toBeTruthy();
});
`;
    // 1ª tentativa: seletor errado (falha de automação, não do produto)
    writeFileSync(join(dir, 'CT-001.spec.ts'), specFile('Nome completo'));
    const first = await h.ok('automation_run', { issueKey: 'FIX-90' });
    expect(first).toMatchObject({ kind: 'attempt 1/2', total: 1, passed: 0 });
    expect(first.failed[0].title).toBe('CT-001 — cadastrar aluno');
    expect(first.failed[0].error).toMatch(/Nome completo/);

    expect((await h.call('automation_run', { issueKey: 'FIX-90', validate: true })).text).toMatch(/validação só depois de uma tentativa com todos os testes passando/);

    // 2ª tentativa: corrigido
    writeFileSync(join(dir, 'CT-001.spec.ts'), specFile('Nome'));
    const second = await h.ok('automation_run', { issueKey: 'FIX-90' });
    expect(second).toMatchObject({ kind: 'attempt 2/2', total: 1, passed: 1, failed: [], flaky: [] });

    expect((await h.call('automation_run', { issueKey: 'FIX-90' })).text).toMatch(/limite de 2 tentativas atingido/);

    const validation = await h.ok('automation_run', { issueKey: 'FIX-90', validate: true });
    expect(validation).toMatchObject({ kind: 'validation', total: 1, passed: 1, flaky: [], delivered: true });
    expect(existsSync(join(h.root, validation.report))).toBe(true);

    const metrics = await h.ok('metrics_run', { runIdOrKey: runId });
    expect(metrics.automation).toEqual({ attempts: 2, validations: 1, basis: 'validation', total: 1, passed: 1, successRate: 1, flakyRate: 0, delivered: true });
    const tests = h.db.prepare('SELECT scenario_code, status, attempts FROM automation_tests ORDER BY id').all();
    expect(tests).toEqual([
      { scenario_code: 'CT-001', status: 'failed', attempts: 1 },
      { scenario_code: 'CT-001', status: 'passed', attempts: 1 },
      { scenario_code: 'CT-001', status: 'passed', attempts: 2 },
    ]);
  }, 180_000);
});
