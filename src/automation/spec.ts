import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { toPlaywrightCode, type Target } from '../browser/target.ts';
import type { VerifyInput } from '../browser/service.ts';
import { buildExecutionKnowledge, playwrightLine } from '../knowledge/execution.ts';
import type { Redactor } from '../security/redact.ts';
import type { DigestCache, JiraDigest } from '../sources/digest.ts';
import type { CleanupSpec } from '../state/cleanup.ts';
import type { Db } from '../state/db.ts';
import { StateError, type StateStore } from '../state/store.ts';
import type { Suitability } from './suitability.ts';

/**
 * AUTOMATION.md: especificação de automação gerada do que o teste manual executou e
 * verificou (não do card). Deve bastar para outro Claude implementar sem redescobrir.
 */

interface ActionRow { action: string; target_json: string | null; value_ref: string | null; value_sample: string | null; url: string | null }
interface VerificationRow { kind: string; description: string; expected: string | null; actual: string | null; spec_json: string | null; id: number }

/** Assertion Playwright equivalente a uma verificação manual aprovada. */
export function assertionFor(kind: string, spec: VerifyInput | undefined): string {
  if (!spec) return `// ${kind}: verificação sem parâmetros registrados — implementar a partir de "esperado"`;
  const loc = spec.target ? toPlaywrightCode(spec.target as Target) : undefined;
  const q = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  const ui = (prefix = '') => {
    if (!loc) return '// ui sem alvo';
    switch (spec.condition ?? 'visible') {
      case 'visible': return `${prefix}await expect(${loc}).toBeVisible();`;
      case 'hidden': return `${prefix}await expect(${loc}).toBeHidden();`;
      case 'containsText': return `${prefix}await expect(${loc}).toContainText(${q(spec.text ?? '')});`;
      case 'hasValue': return `${prefix}await expect(${loc}).toHaveValue(${q(spec.text ?? '')});`;
      case 'enabled': return `${prefix}await expect(${loc}).toBeEnabled();`;
      case 'disabled': return `${prefix}await expect(${loc}).toBeDisabled();`;
      case 'checked': return `${prefix}await expect(${loc}).toBeChecked();`;
      case 'count': return `${prefix}await expect(${loc}).toHaveCount(${spec.count ?? 0});`;
      case 'attribute': return `${prefix}await expect(${loc}).toHaveAttribute(${q(spec.attribute ?? '')}, new RegExp(${q((spec.text ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))}));`;
    }
  };
  switch (kind) {
    case 'ui': return ui();
    case 'persistence': return `${spec.path ? `await page.goto(${q(spec.path)});` : 'await page.reload();'} ${ui()}`;
    case 'url': {
      const p = spec.urlPattern ?? '';
      return p.length > 2 && p.startsWith('/') && p.endsWith('/') ? `await expect(page).toHaveURL(${p});` : `await expect(page).toHaveURL(new RegExp(${q(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))}));`;
    }
    case 'network': {
      const method = spec.method ? ` && r.request().method() === ${q(spec.method.toUpperCase())}` : '';
      const status = spec.status && !/xx$/i.test(spec.status) ? `expect(res.status()).toBe(${Number(spec.status)});` : 'expect(res.ok()).toBeTruthy();';
      const body = spec.bodyContains ? ` expect(await res.text()).toContain(${q(spec.bodyContains)});` : '';
      return `// registrar ANTES da ação: const resP = page.waitForResponse((r) => r.url().includes(${q(spec.urlContains ?? '')})${method}); … const res = await resP; ${status}${body}`;
    }
    case 'api': {
      const status = spec.status && !/xx$/i.test(spec.status) ? `expect(res.status()).toBe(${Number(spec.status)});` : 'expect(res.ok()).toBeTruthy();';
      const body = spec.bodyContains ? ` expect(await res.text()).toContain(${q(spec.bodyContains)});` : '';
      return `const res = await page.request.get(${q(spec.path ?? '')}); ${status}${body}`;
    }
    case 'console': return `// coletar erros: page.on('console', (m) => m.type() === 'error' && errors.push(m.text())); … expect(errors).toEqual([]);`;
    default: return `// ${kind}`;
  }
}

export function buildAutomationSpec(
  deps: { db: Db; store: StateStore; cache: DigestCache; rootDir: string; redactor: Redactor },
  runId: string,
) {
  const { db, store, cache, rootDir, redactor } = deps;
  const run = store.getRun(runId);
  const scenarios = store.scenarioDetails(runId);
  const approved = scenarios.filter((s) => (db.prepare('SELECT automation_approved AS a FROM scenarios WHERE id = ?').get(s.id) as { a: number }).a === 1);
  if (approved.length === 0) throw new StateError('nenhum cenário aprovado para automação — rode automation_assess antes');

  const digest = cache.get('jira', run.issue_key);
  const issue = digest.hit ? (digest.digest as JiraDigest) : undefined;
  const role = (db.prepare(`SELECT payload FROM events WHERE run_id = ? AND type = 'browser.open' ORDER BY id DESC LIMIT 1`).get(runId) as { payload: string } | undefined);
  const roleName = role ? (JSON.parse(role.payload) as { role: string | null }).role : null;
  const actionsOf = (scenarioId: number | null) =>
    db.prepare(`SELECT action, target_json, value_ref, value_sample, url FROM actions WHERE run_id = ? AND ok = 1 AND ${scenarioId === null ? 'scenario_id IS NULL' : `scenario_id = ? AND ts >= COALESCE((SELECT started_at FROM scenarios WHERE id = scenario_id), '')`} ORDER BY seq`)
      .all(...(scenarioId === null ? [runId] : [runId, scenarioId])) as unknown as ActionRow[];
  const line = (a: ActionRow) => playwrightLine(a.action, JSON.parse(a.target_json ?? '{}'), a.value_ref);

  // Massa: um valor de exemplo por tipo semântico (ou por alvo, se literal).
  const testData: Record<string, { sample: string; usedIn: string[]; note?: string }> = {};
  const selectors = new Map<string, string>();
  const md: string[] = [];
  md.push(`# AUTOMATION — ${run.issue_key}${issue ? ` · ${issue.title}` : ''}`, '');
  md.push(`> Gerado de ${run.id} (teste manual em ${run.env}). A fonte é o comportamento **observado e verificado**, não o card. Passos e seletores abaixo funcionaram nesse run.`, '');
  md.push('## Contexto', '');
  if (issue) {
    md.push(issue.summary, '', '**Critérios de aceite**', ...issue.acceptanceCriteria.map((c) => `- ${c}`), '');
  }
  md.push(`- Ambiente do teste manual: \`${run.env}\` · papel: \`${roleName ?? 'nenhum'}\``);
  md.push(`- Credenciais: \`credentials('${roleName ?? '<papel>'}')\` de \`env.ts\` (lê o .env; nunca escreva senha no teste).`, '');

  const setup = actionsOf(null);
  if (setup.length) {
    md.push('## Preparação validada (login / setup)', '', '```ts', ...setup.map((a) => {
      const l = line(a);
      return a.value_ref?.startsWith('role:') ? `${l}  // ${a.value_ref.endsWith('password') ? 'credentials(role).password' : 'credentials(role).username'}` : l;
    }), '```', '');
  }

  md.push('## Cenários', '');
  for (const s of approved) {
    const suit = JSON.parse((db.prepare('SELECT automation_suitability AS j FROM scenarios WHERE id = ?').get(s.id) as { j: string }).j) as Suitability;
    const actions = actionsOf(s.id);
    const verifs = (db.prepare(`SELECT id, kind, description, expected, actual, spec_json FROM verifications WHERE scenario_id = ? AND passed = 1 AND ts >= COALESCE((SELECT started_at FROM scenarios WHERE id = scenario_id), '') ORDER BY id`).all(s.id) as unknown as VerificationRow[]);
    const latest = [...new Map(verifs.map((v) => [`${v.kind}|${v.description}`, v])).values()];
    const evidence = (db.prepare('SELECT path FROM evidence WHERE scenario_id = ? ORDER BY id').all(s.id) as { path: string }[]).map((e) => e.path);
    const created = store.listCreatedData(runId).filter((d) => d.scenario_id === s.id);

    md.push(`### ${s.code} — ${s.title}`, '');
    md.push(`- Prioridade ${s.priority} · risco ${s.risk} · tipos: ${s.types.join(', ') || '—'}`);
    md.push(`- Resultado manual: ${s.status} · confidence ${s.confidence ?? '—'} · suitability ${suit.score} (${suit.level})${suit.reasons.length ? ` — ${suit.reasons.join('; ')}` : ''}`);
    if (s.preconditions) md.push(`- Pré-condições: ${s.preconditions}`);
    md.push(`- Esperado: ${s.expected}`, '');
    md.push('**Passos validados**', '', '```ts');
    for (const a of actions) {
      md.push(line(a));
      const target = a.target_json ? (JSON.parse(a.target_json) as Target | { url: string }) : undefined;
      if (target && !('url' in target)) selectors.set(toPlaywrightCode(target), a.url ? new URL(a.url).pathname : '');
      if (a.value_sample) {
        const key = a.value_ref?.startsWith('type:') && a.value_ref !== 'type:literal' ? a.value_ref.slice(5) : (target && 'label' in target && target.label) || `valor_${Object.keys(testData).length + 1}`;
        const entry = testData[key] ?? { sample: a.value_sample, usedIn: [] };
        if (!entry.usedIn.includes(s.code)) entry.usedIn.push(s.code);
        testData[key] = entry;
      }
    }
    md.push('```', '');
    md.push('**Assertions (das verificações aprovadas no teste manual)**', '');
    for (const v of latest) {
      md.push(`- ${v.kind} — ${v.description}: esperado ${v.expected ?? '—'}; observado ${v.actual ?? '—'}`);
      md.push(`  \`${assertionFor(v.kind, v.spec_json ? (JSON.parse(v.spec_json) as VerifyInput) : undefined)}\``);
    }
    md.push('');
    if (created.length) {
      md.push('**Dados criados e limpeza** (implementar em `afterEach` com `request`, fora da rota do guard)', '');
      for (const d of created) {
        const c = d.cleanup_json ? (JSON.parse(d.cleanup_json) as CleanupSpec) : undefined;
        md.push(`- ${d.resource}: ${c?.method === 'api' ? `${c.request.method} ${c.request.path.replace(d.ext_id ?? '§', '<id criado>')}; verificar GET ${c.verify.path}` : c?.method === 'manual' ? `${c.note}; verificar GET ${c.verify.path}` : 'sem limpeza registrada'}`);
      }
      md.push('- O id muda a cada execução: capture-o da resposta da criação (`waitForResponse`).', '');
    }
    if (evidence.length) md.push(`Evidência manual: ${evidence.map((e) => `\`${e}\``).join(', ')}`, '');
  }

  if (selectors.size) {
    md.push('## Seletores descobertos', '', ...[...selectors].map(([sel, route]) => `- \`${sel}\`${route ? ` — ${route}` : ''}`), '');
  }
  const skipped = scenarios.filter((s) => !approved.includes(s));
  if (skipped.length) {
    md.push('## Fora da automação', '');
    for (const s of skipped) {
      const j = (db.prepare('SELECT automation_suitability AS j FROM scenarios WHERE id = ?').get(s.id) as { j: string | null }).j;
      const suit = j ? (JSON.parse(j) as Suitability) : undefined;
      md.push(`- ${s.code} ${s.title} — ${suit ? `${suit.score} (${suit.level}): ${suit.reasons.join('; ')}` : `${s.status}, não avaliado`}`);
    }
    md.push('');
  }
  md.push('## Regras de implementação', '');
  md.push(
    '- Arquivo: `tests/' + run.issue_key + '/<cenário>.spec.ts`; título do teste começa pelo código (`CT-001 — …`).',
    "- Importe `test`/`expect` de `../../fixtures` (guard: DELETE da página bloqueado; use `test.use({ allowDelete: ['/caminho'] })` só se o cenário excluir pela UI).",
    '- Reaproveite e crie Page Objects em `pages/`; login em um Page Object/fixture reutilizável.',
    '- Seletores: getByRole > getByLabel > getByPlaceholder > getByTestId > estáveis. Sem XPath, sem nth() desnecessário, sem coordenadas.',
    "- Massa criada pelo teste: `unique('prefixo')` de `../../fixtures` (a validação roda cada teste 2× em paralelo; `Date.now()` sozinho colide) — exemplos em `test-data.json`.",
    '- Nada de `waitForTimeout`; espere por estado (assertion, response).',
  );

  const dir = join(rootDir, 'automation', run.project, 'specs', run.issue_key);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'AUTOMATION.md'), redactor.text(md.join('\n')));
  writeFileSync(join(dir, 'test-data.json'), redactor.text(`${JSON.stringify(testData, null, 2)}\n`));
  writeFileSync(join(dir, 'execution-knowledge.json'), `${JSON.stringify(buildExecutionKnowledge(store, run), null, 2)}\n`);
  const rel = `automation/${run.project}/specs/${run.issue_key}`;
  return { dir: rel, files: [`${rel}/AUTOMATION.md`, `${rel}/test-data.json`, `${rel}/execution-knowledge.json`], scenarios: approved.map((s) => s.code), skipped: skipped.map((s) => s.code) };
}

