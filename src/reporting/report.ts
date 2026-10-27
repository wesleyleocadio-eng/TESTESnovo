import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatMetrics, type RunMetrics } from '../metrics/run-metrics.ts';
import type { Redactor } from '../security/redact.ts';
import { renderHtml, type HtmlModel } from './html.ts';
import type { DigestCache, JiraDigest } from '../sources/digest.ts';
import type { Db } from '../state/db.ts';
import type { ScenarioDetails, StateStore } from '../state/store.ts';

/**
 * Relatório gerado só a partir do que foi registrado (cenários, verificações, evidências,
 * guard, limpeza) — nada é narrado pelo modelo além do resumo e das observações que ele gravou.
 */

const STATUS_ICON: Record<string, string> = {
  PASSED: '✅', FAILED: '❌', BLOCKED: '⛔', NEEDS_REVIEW: '🔎', NOT_EXECUTED: '⏭️', PENDING: '…', IN_PROGRESS: '▶️',
};

interface Row { [k: string]: unknown }

export interface Explanation { code: string; title: string; howToSee: string; happens: string; expected: string; note?: string }

const clock = (sec: number) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;

export function buildReport(
  deps: { db: Db; store: StateStore; cache: DigestCache; rootDir: string; redactor: Redactor; metrics?: RunMetrics },
  runId: string,
) {
  const { db, store, cache, rootDir, redactor } = deps;
  const run = store.getRun(runId);
  const scenarios = store.scenarioDetails(runId);
  const count = (pred: (s: ScenarioDetails) => boolean) => scenarios.filter(pred).length;
  const by = (status: string) => count((s) => s.status === status);

  const planned = count((s) => s.origin !== 'exploratory');
  const exploratory = scenarios.filter((s) => s.origin === 'exploratory');
  const executed = count((s) => ['PASSED', 'FAILED', 'BLOCKED', 'NEEDS_REVIEW'].includes(s.status));
  const bugs = scenarios.filter((s) => s.status === 'FAILED' && s.classification === 'PRODUCT_BUG');

  const all = (sql: string, ...p: (string | number)[]) => db.prepare(sql).all(...p) as Row[];
  const one = (sql: string, ...p: (string | number)[]) => db.prepare(sql).get(...p) as Row;
  const guardBlocks = all(`SELECT type, payload FROM events WHERE run_id = ? AND type IN ('guard.block','guard.network_block') ORDER BY id`, runId);
  const approvals = all(`SELECT action, target, level, decision FROM approvals WHERE run_id = ? AND level <> 'PLAN' ORDER BY id`, runId);
  const created = store.listCreatedData(runId);
  const toolCalls = Number(one(`SELECT COUNT(*) AS n FROM events WHERE run_id = ? AND type LIKE 'tool.%'`, runId).n);
  const screenshots = Number(one(`SELECT COUNT(*) AS n FROM evidence WHERE run_id = ? AND kind = 'screenshot'`, runId).n);
  const actions = Number(one(`SELECT COUNT(*) AS n FROM actions WHERE run_id = ?`, runId).n);
  const minutes = run.ended_at ? Math.round((Date.parse(run.ended_at) - Date.parse(run.started_at)) / 60000) : undefined;

  const digest = cache.get('jira', run.issue_key);
  const issue = digest.hit ? (digest.digest as JiraDigest) : undefined;

  // Reteste: compara cada cenário com o resultado do run pai.
  const before = new Map(run.parent_run_id ? store.scenarioDetails(run.parent_run_id).map((s) => [s.code, s.status] as const) : []);
  const compared = scenarios.filter((s) => before.has(s.code)).map((s) => ({ s, was: before.get(s.code)! }));
  const fixed = compared.filter(({ s, was }) => was !== 'PASSED' && s.status === 'PASSED').length;
  const stillFailing = compared.filter(({ s, was }) => was === 'FAILED' && s.status === 'FAILED').length;
  const regressed = compared.filter(({ s, was }) => was === 'PASSED' && s.status === 'FAILED').length;

  const summary = [
    `${run.issue_key} · ${run.id} · ${run.env} (${run.mode})`,
    `Planned: ${planned}  Executed: ${executed}`,
    `PASS: ${by('PASSED')}  FAIL: ${by('FAILED')}  BLOCKED: ${by('BLOCKED')}  NEEDS_REVIEW: ${by('NEEDS_REVIEW')}  NOT_EXECUTED: ${by('NOT_EXECUTED')}`,
    `Exploratory scenarios: ${exploratory.length}  Bugs confirmed: ${bugs.length}`,
    ...(run.parent_run_id ? [`Retest de ${run.parent_run_id}: corrigidos ${fixed} · ainda falham ${stillFailing} · regressões ${regressed}`] : []),
    `Guard: ${guardBlocks.length} bloqueio(s), ${approvals.length} aprovação(ões) RED · Limpeza: ${created.filter((d) => d.cleanup_status === 'VERIFIED').length}/${created.filter((d) => d.cleanup_status !== 'KEPT').length} verificada(s)`,
    `Recommendation: ${run.recommendation ?? '(run não concluído)'}`,
  ].join('\n');

  const evidenceOf = (s: ScenarioDetails) =>
    all(`SELECT kind, path, meta FROM evidence WHERE scenario_id = ? ORDER BY id`, s.id).map((e) => {
      const at = e.kind === 'video' ? (JSON.parse(String(e.meta ?? '{}')) as { atSec?: number }).atSec : undefined;
      return `\`${String(e.path)}\` (${String(e.kind)}${at !== undefined ? ` a partir de ${clock(at)}` : ''})`;
    });
  const verificationsOf = (s: ScenarioDetails, passed: 0 | 1) =>
    all(`SELECT id, kind, description, expected, actual, passed FROM verifications WHERE scenario_id = ? AND passed = ? AND ts >= COALESCE((SELECT started_at FROM scenarios WHERE id = scenario_id), '') ORDER BY id`, s.id, passed);

  // Explicação em linguagem simples (a mais recente gravada via report_build).
  const explainRow = all(`SELECT payload FROM events WHERE run_id = ? AND type = 'report.explain' ORDER BY id DESC LIMIT 1`, runId)[0];
  const explanations = explainRow ? (JSON.parse(String(explainRow.payload)) as Explanation[]) : [];

  const md: string[] = [];
  md.push(`# ${run.issue_key} — ${issue?.title ?? 'relatório de QA'}`, '');
  md.push('```text', summary, '```', '');
  if (run.summary) md.push('## Conclusão', '', run.summary, '');
  if (explanations.length) {
    md.push('## Bugs explicados', '');
    explanations.forEach((e, i) => {
      md.push(`### ${i + 1}. ${e.title} (${e.code})`, '', `- Como ver: ${e.howToSee}`, `- O que acontece: ${e.happens}`, `- O que o card pede: ${e.expected}`);
      if (e.note) md.push(`- Observação: ${e.note}`);
      md.push('');
    });
  }

  md.push('## Cenários', '', '| Cenário | Título | Prioridade | Resultado | Confiança | Classificação |', '| --- | --- | --- | --- | --- | --- |');
  for (const s of scenarios) {
    md.push(`| ${s.code} | ${s.title} | ${s.priority} | ${STATUS_ICON[s.status] ?? ''} ${s.status} | ${s.confidence ?? '—'} | ${s.classification ?? '—'} |`);
  }
  md.push('');

  if (compared.length) {
    md.push(`## Comparação com ${run.parent_run_id}`, '', '| Cenário | Antes | Agora | |', '| --- | --- | --- | --- |');
    for (const { s, was } of compared) {
      const note = was !== 'PASSED' && s.status === 'PASSED' ? 'corrigido' : was === 'PASSED' && s.status === 'FAILED' ? '**regressão**' : was === s.status ? 'sem mudança' : '';
      md.push(`| ${s.code} | ${was} | ${s.status} | ${note} |`);
    }
    md.push('');
  }

  const failed = scenarios.filter((s) => s.status === 'FAILED');
  if (failed.length) {
    md.push('## Falhas', '');
    for (const s of failed) {
      md.push(`### ${s.code} — ${s.title}`, '', `- Classificação: **${s.classification}** · confiança ${s.confidence}`, `- Esperado: ${s.expected}`, `- Observado: ${s.observed ?? '—'}`);
      for (const v of verificationsOf(s, 0)) md.push(`- Verificação reprovada (${v.kind}) "${v.description}": esperado ${v.expected}; obtido ${v.actual}`);
      if (s.preconditions) md.push(`- Pré-condições: ${s.preconditions}`);
      md.push('- Passos:', ...s.steps.map((p, i) => `  ${i + 1}. ${p}`));
      const ev = evidenceOf(s);
      if (ev.length) md.push(`- Evidências: ${ev.join(', ')}`);
      md.push('');
    }
  }

  const pending = scenarios.filter((s) => ['BLOCKED', 'NEEDS_REVIEW', 'NOT_EXECUTED'].includes(s.status));
  if (pending.length) {
    md.push('## Bloqueados, em revisão e não executados', '');
    for (const s of pending) md.push(`- **${s.code}** ${s.title} — ${s.status}${s.classification ? ` (${s.classification})` : ''}: ${s.reason ?? '—'}`);
    md.push('');
  }

  if (exploratory.length) {
    md.push('## Exploratórios', '');
    for (const s of exploratory) md.push(`- **${s.code}**${s.parent_code ? ` (de ${s.parent_code})` : ''} ${s.title} — ${s.status}${s.observed ? `: ${s.observed}` : ''}`);
    md.push('');
  }

  if (guardBlocks.length || approvals.length) {
    md.push('## Action Guard', '');
    for (const g of guardBlocks) {
      const p = JSON.parse(String(g.payload ?? '{}')) as Record<string, unknown>;
      md.push(g.type === 'guard.network_block'
        ? `- 🚧 Request ${p.method} ${p.path} barrada na rede — **verifique**: uma ação não destrutiva tentou excluir dados`
        : `- 🛑 Ação ${p.level} bloqueada: ${p.reason}`);
    }
    for (const a of approvals) md.push(`- ✔️ ${a.level} aprovada: ${a.action} em ${a.target} — ${String(a.decision).replace(/^APPROVED: /, '')}`);
    md.push('');
  }

  if (created.length) {
    md.push('## Dados criados e limpeza', '');
    for (const d of created) md.push(`- #${d.id} ${d.resource}${d.ext_id ? ` (${d.ext_id})` : ''}: ${d.cleanup_status}`);
    md.push('');
  }

  const reclassified = all(
    `SELECT s.code, e.payload FROM events e JOIN scenarios s ON s.id = e.scenario_id WHERE e.run_id = ? AND e.type = 'scenario.reclassify' ORDER BY e.id`, runId,
  ).map((r) => {
    const p = JSON.parse(String(r.payload)) as { from: { status: string; classification: string | null }; to: { status: string; classification: string | null }; justification: string };
    const fmt = (x: { status: string; classification: string | null }) => `${x.status}${x.classification ? `/${x.classification}` : ''}`;
    return `${String(r.code)}: ${fmt(p.from)} → ${fmt(p.to)} — ${p.justification}`;
  });
  if (reclassified.length) md.push('## Reclassificações', '', ...reclassified.map((l) => `- ${l}`), '');

  const videos = all(`SELECT path, meta FROM evidence WHERE run_id = ? AND kind = 'video' AND scenario_id IS NULL ORDER BY id`, runId);
  if (videos.length) {
    md.push('## Vídeos', '');
    for (const v of videos) {
      const chapters = (JSON.parse(String(v.meta ?? '{}')) as { chapters?: { code: string; atSec: number }[] }).chapters ?? [];
      const marks = chapters.map((c) => `${c.code} em ${clock(c.atSec)}`).join(' · ');
      md.push(`- \`${String(v.path)}\`${marks ? ` — ${marks}` : ''}`);
    }
    md.push('');
  }

  if (issue?.openQuestions.length) md.push('## Pontos em aberto do card', '', ...issue.openQuestions.map((q) => `- ${q}`), '');

  if (deps.metrics) {
    md.push('## Métricas', '', ...formatMetrics(deps.metrics).map((l) => `- ${l}`));
    const costly = deps.metrics.perScenario.costliest.filter((c) => c.calls > 0);
    if (costly.length) md.push('- Cenários mais caros: ' + costly.map((c) => `${c.code} ${c.fresh} tokens/${c.calls} chamadas/${c.minutes} min`).join(' · '));
    md.push('');
  } else {
    md.push('## Execução', '', `- Chamadas de ferramenta: ${toolCalls} · ações no navegador: ${actions} · screenshots: ${screenshots}${minutes !== undefined ? ` · duração: ${minutes} min` : ''}`, '');
  }

  // Rascunho para o Jira: publicar é ação externa e exige pedido explícito do usuário.
  md.push('## Rascunho de comentário para o Jira (não publicado)', '', '```markdown');
  md.push(`**QA ${run.recommendation ?? 'em andamento'}** — ${run.issue_key} (${run.env})`, '');
  md.push(`PASS ${by('PASSED')} · FAIL ${by('FAILED')} · BLOCKED ${by('BLOCKED')} · NEEDS_REVIEW ${by('NEEDS_REVIEW')} · exploratórios ${exploratory.length}`);
  for (const s of failed) md.push(`- ❌ ${s.code} ${s.title}: ${s.observed ?? ''} (${s.classification})`);
  for (const s of pending) md.push(`- ${STATUS_ICON[s.status]} ${s.code} ${s.title}: ${s.reason ?? ''}`);
  md.push('```', '');

  const dir = join(rootDir, 'reports', run.issue_key);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${run.id}.md`), redactor.text(md.join('\n')));

  // HTML (sempre): mesmo conteúdo, com as verificações de cada cenário, miniaturas e vídeo com capítulos.
  const jiraStart = md.indexOf('```markdown');
  const model: HtmlModel = {
    issueKey: run.issue_key,
    title: issue?.title ?? 'relatório de QA',
    runId: run.id,
    env: run.env,
    mode: run.mode,
    recommendation: run.recommendation,
    conclusion: run.summary,
    explanations,
    counts: {
      planned, executed, passed: by('PASSED'), failed: by('FAILED'), blocked: by('BLOCKED'), review: by('NEEDS_REVIEW'),
      notExecuted: by('NOT_EXECUTED'), exploratory: exploratory.length, bugs: bugs.length,
    },
    ...(run.parent_run_id ? { retest: { parent: run.parent_run_id, fixed, stillFailing, regressed, rows: compared.map(({ s, was }) => ({ code: s.code, was, now: s.status })) } } : {}),
    scenarios: scenarios.map((s) => ({
      code: s.code, title: s.title, priority: s.priority, risk: s.risk, status: s.status, origin: s.origin, parent: s.parent_code,
      confidence: s.confidence, classification: s.classification, expected: s.expected, observed: s.observed, reason: s.reason,
      preconditions: s.preconditions, steps: s.steps,
      checks: [...verificationsOf(s, 1), ...verificationsOf(s, 0)]
        .map((v) => ({ id: Number(v.id), kind: String(v.kind), description: String(v.description), expected: String(v.expected ?? ''), actual: String(v.actual ?? ''), passed: Number(v.passed) === 1 }))
        .sort((a, b) => a.id - b.id),
      evidence: all(`SELECT kind, path, meta FROM evidence WHERE scenario_id = ? ORDER BY id`, s.id).map((e) => {
        const at = e.kind === 'video' ? (JSON.parse(String(e.meta ?? '{}')) as { atSec?: number }).atSec : undefined;
        return { kind: String(e.kind), path: String(e.path), ...(at !== undefined ? { atSec: at } : {}) };
      }),
    })),
    videos: videos.map((v) => ({ path: String(v.path), chapters: (JSON.parse(String(v.meta ?? '{}')) as { chapters?: { code: string; atSec: number }[] }).chapters ?? [] })),
    guard: guardBlocks.map((g) => {
      const p = JSON.parse(String(g.payload ?? '{}')) as Record<string, unknown>;
      return g.type === 'guard.network_block' ? `Request ${p.method} ${p.path} barrada na rede (ação não destrutiva tentou excluir dados)` : `Ação ${p.level} bloqueada: ${p.reason}`;
    }).concat(approvals.map((a) => `${a.level} aprovada: ${a.action} em ${a.target} — ${String(a.decision).replace(/^APPROVED: /, '')}`)),
    cleanup: created.map((d) => `#${d.id} ${d.resource}${d.ext_id ? ` (${d.ext_id})` : ''}: ${d.cleanup_status}`),
    reclassified,
    openQuestions: issue?.openQuestions ?? [],
    metrics: deps.metrics ? formatMetrics(deps.metrics) : [`Chamadas de ferramenta: ${toolCalls} · ações no navegador: ${actions} · screenshots: ${screenshots}`],
    jiraDraft: md.slice(jiraStart + 1, md.lastIndexOf('```')).join('\n').trim(),
    generatedAt: new Date().toLocaleString('pt-BR'),
  };
  writeFileSync(join(dir, `${run.id}.html`), redactor.text(renderHtml(model)));
  return { summary, report: `reports/${run.issue_key}/${run.id}.md`, html: `reports/${run.issue_key}/${run.id}.html` };
}
