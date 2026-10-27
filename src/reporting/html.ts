/**
 * Relatório HTML local (abre com duplo clique): resumo, cenários com as verificações que os
 * sustentam, evidências em miniatura e vídeo com capítulos clicáveis. Tudo relativo à pasta
 * reports/<card>/, apontando para runs/ — nada sai da máquina.
 */

export interface HtmlCheck { kind: string; description: string; expected: string; actual: string; passed: boolean }
export interface HtmlEvidence { kind: string; path: string; atSec?: number }
export interface HtmlScenario {
  code: string; title: string; priority: string; risk: string; status: string; origin: string; parent: string | null;
  confidence: string | null; classification: string | null; expected: string; observed: string | null; reason: string | null;
  preconditions: string | null; steps: string[]; checks: HtmlCheck[]; evidence: HtmlEvidence[];
}
export interface HtmlVideo { path: string; chapters: { code: string; atSec: number }[] }
export interface HtmlModel {
  issueKey: string; title: string; runId: string; env: string; mode: string; recommendation: string | null; conclusion: string | null;
  explanations: { code: string; title: string; howToSee: string; happens: string; expected: string; note?: string }[];
  counts: { planned: number; executed: number; passed: number; failed: number; blocked: number; review: number; notExecuted: number; exploratory: number; bugs: number };
  retest?: { parent: string; fixed: number; stillFailing: number; regressed: number; rows: { code: string; was: string; now: string }[] };
  scenarios: HtmlScenario[];
  videos: HtmlVideo[];
  guard: string[];
  cleanup: string[];
  reclassified: string[];
  openQuestions: string[];
  metrics: string[];
  jiraDraft: string;
  generatedAt: string;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const clock = (sec: number) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
/** Caminho de runs/… visto a partir de reports/<card>/ */
const rel = (path: string) => `../../${path.split('/').map(encodeURIComponent).join('/')}`;

const STATUS_LABEL: Record<string, string> = {
  PASSED: 'Passou', FAILED: 'Falhou', BLOCKED: 'Bloqueado', NEEDS_REVIEW: 'Em revisão', NOT_EXECUTED: 'Não executado', PENDING: 'Pendente', IN_PROGRESS: 'Em andamento',
};
const RECOMMENDATION_CLASS: Record<string, string> = { APROVADO: 'ok', REPROVADO: 'bad', INCONCLUSIVO: 'warn' };

export function renderHtml(m: HtmlModel): string {
  const videoId = (path: string) => `v${m.videos.findIndex((v) => v.path === path)}`;
  const badge = (status: string) => `<span class="badge s-${status.toLowerCase()}">${esc(STATUS_LABEL[status] ?? status)}</span>`;
  const seek = (path: string, at: number, label: string) =>
    `<button class="seek" onclick="seek('${videoId(path)}',${at})">▶ ${esc(label)}</button>`;

  const card = (label: string, value: number, cls = '') => `<div class="card ${cls}"><div class="n">${value}</div><div class="l">${esc(label)}</div></div>`;

  const scenarioHtml = (s: HtmlScenario) => {
    const video = s.evidence.find((e) => e.kind === 'video' && e.atSec !== undefined);
    const shots = s.evidence.filter((e) => e.kind === 'screenshot');
    const other = s.evidence.filter((e) => e.kind !== 'screenshot' && e.kind !== 'video');
    const open = s.status === 'FAILED' || s.status === 'NEEDS_REVIEW' ? ' open' : '';
    return `
<details class="scenario" id="${esc(s.code)}"${open}>
  <summary>
    ${badge(s.status)} <b>${esc(s.code)}</b> ${esc(s.title)}
    <span class="meta">${esc(s.priority)} · risco ${esc(s.risk)}${s.confidence ? ` · confiança ${esc(s.confidence)}` : ''}${s.classification ? ` · ${esc(s.classification)}` : ''}${s.parent ? ` · de ${esc(s.parent)}` : ''}</span>
    ${video ? seek(video.path, video.atSec!, clock(video.atSec!)) : ''}
  </summary>
  <div class="body">
    ${s.preconditions ? `<p><b>Pré-condições:</b> ${esc(s.preconditions)}</p>` : ''}
    <p><b>Passos:</b></p><ol>${s.steps.map((p) => `<li>${esc(p)}</li>`).join('')}</ol>
    <p><b>Esperado:</b> ${esc(s.expected)}</p>
    ${s.observed ? `<p><b>Observado:</b> ${esc(s.observed)}</p>` : ''}
    ${s.reason ? `<p><b>Motivo:</b> ${esc(s.reason)}</p>` : ''}
    ${s.checks.length ? `<table class="checks"><thead><tr><th></th><th>Verificação</th><th>Esperado</th><th>Observado</th></tr></thead><tbody>${s.checks
      .map((c) => `<tr class="${c.passed ? 'pass' : 'fail'}"><td>${c.passed ? '✓' : '✗'}</td><td><span class="kind">${esc(c.kind)}</span> ${esc(c.description)}</td><td>${esc(c.expected)}</td><td>${esc(c.actual)}</td></tr>`)
      .join('')}</tbody></table>` : '<p class="muted">Sem verificações registradas.</p>'}
    ${shots.length ? `<div class="shots">${shots.map((e) => `<a href="${rel(e.path)}" target="_blank"><img loading="lazy" src="${rel(e.path)}" alt="${esc(e.path)}"></a>`).join('')}</div>` : ''}
    ${other.length ? `<p class="muted">${other.map((e) => `<a href="${rel(e.path)}">${esc(e.kind)}: ${esc(e.path.split('/').pop() ?? e.path)}</a>`).join(' · ')}</p>` : ''}
  </div>
</details>`;
  };

  const section = (title: string, items: string[]) =>
    items.length ? `<section><h2>${esc(title)}</h2><ul>${items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul></section>` : '';

  const c = m.counts;
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(m.issueKey)} — relatório NOVO QA</title>
<style>
:root { --bg:#f6f7f9; --fg:#1d2330; --muted:#667085; --card:#fff; --line:#e4e7ec; --ok:#12805c; --bad:#c0362c; --warn:#b54708; --info:#175cd3; --soft:#eef2f6; }
@media (prefers-color-scheme: dark) { :root { --bg:#0f1218; --fg:#e6e9ef; --muted:#98a2b3; --card:#171b23; --line:#2a303b; --soft:#1e2430; } }
* { box-sizing: border-box; }
body { margin:0; font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif; background:var(--bg); color:var(--fg); }
main { max-width:1100px; margin:0 auto; padding:24px 16px 64px; }
h1 { font-size:22px; margin:0 0 4px; } h2 { font-size:17px; margin:28px 0 10px; }
.sub { color:var(--muted); font-size:13px; }
.rec { display:inline-block; margin-top:10px; padding:4px 12px; border-radius:999px; font-weight:600; color:#fff; }
.rec.ok{background:var(--ok)} .rec.bad{background:var(--bad)} .rec.warn{background:var(--warn)}
.cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(110px,1fr)); gap:10px; margin-top:16px; }
.card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:10px 12px; }
.card .n { font-size:24px; font-weight:700; } .card .l { color:var(--muted); font-size:12px; }
.card.ok .n{color:var(--ok)} .card.bad .n{color:var(--bad)} .card.warn .n{color:var(--warn)}
.conclusion { background:var(--card); border:1px solid var(--line); border-left:4px solid var(--info); border-radius:8px; padding:12px 14px; }
.explain { background:var(--card); border:1px solid var(--line); border-left:4px solid var(--bad); border-radius:8px; padding:4px 14px 10px; margin:8px 0; }
.explain h3 { font-size:15px; margin:10px 0 6px; } .explain h3 a { font-weight:400; margin-left:6px; }
.explain dl { display:grid; grid-template-columns:150px 1fr; gap:4px 12px; margin:0; } .explain dt { color:var(--muted); font-size:13px; } .explain dd { margin:0; }
@media (max-width:600px) { .explain dl { grid-template-columns:1fr; } .explain dd { margin-bottom:6px; } }
.scenario { background:var(--card); border:1px solid var(--line); border-radius:10px; margin:8px 0; }
.scenario summary { cursor:pointer; padding:10px 12px; list-style:none; display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
.scenario summary::-webkit-details-marker { display:none; }
.scenario .meta { color:var(--muted); font-size:12px; margin-left:auto; }
.scenario .body { padding:0 14px 12px; border-top:1px solid var(--line); }
.badge { font-size:12px; font-weight:600; padding:2px 8px; border-radius:999px; background:var(--soft); white-space:nowrap; }
.s-passed{color:var(--ok)} .s-failed{color:var(--bad)} .s-blocked,.s-needs_review{color:var(--warn)} .s-not_executed{color:var(--muted)}
.checks { width:100%; border-collapse:collapse; font-size:13px; margin:8px 0; }
.checks th,.checks td { text-align:left; padding:6px 8px; border-bottom:1px solid var(--line); vertical-align:top; word-break:break-word; }
.checks tr.pass td:first-child{color:var(--ok); font-weight:700} .checks tr.fail td:first-child{color:var(--bad); font-weight:700}
.kind { font-size:11px; text-transform:uppercase; color:var(--muted); }
.shots { display:flex; gap:8px; flex-wrap:wrap; } .shots img { width:220px; border:1px solid var(--line); border-radius:6px; }
.seek { font:inherit; font-size:12px; border:1px solid var(--line); background:var(--soft); color:var(--fg); border-radius:6px; padding:2px 8px; cursor:pointer; }
.video { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:12px; margin:10px 0; }
.video video { width:100%; border-radius:6px; background:#000; }
.chapters { display:flex; gap:6px; flex-wrap:wrap; margin-top:8px; }
.muted { color:var(--muted); font-size:13px; }
pre { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:12px; white-space:pre-wrap; font-size:13px; }
table.cmp { border-collapse:collapse; } table.cmp td, table.cmp th { padding:4px 10px; border-bottom:1px solid var(--line); }
</style>
</head>
<body><main>
<h1>${esc(m.issueKey)} — ${esc(m.title)}</h1>
<div class="sub">${esc(m.runId)} · ambiente ${esc(m.env)} · modo ${esc(m.mode)} · gerado em ${esc(m.generatedAt)}</div>
${m.recommendation ? `<div class="rec ${RECOMMENDATION_CLASS[m.recommendation] ?? 'warn'}">${esc(m.recommendation)}</div>` : ''}

<div class="cards">
${card('Planejados', c.planned)}${card('Executados', c.executed)}${card('Passaram', c.passed, 'ok')}${card('Falharam', c.failed, c.failed ? 'bad' : '')}
${card('Bloqueados', c.blocked, c.blocked ? 'warn' : '')}${card('Em revisão', c.review, c.review ? 'warn' : '')}${card('Não executados', c.notExecuted)}${card('Exploratórios', c.exploratory)}${card('Bugs', c.bugs, c.bugs ? 'bad' : '')}
</div>

${m.conclusion ? `<h2>Conclusão</h2><div class="conclusion">${esc(m.conclusion)}</div>` : ''}

${m.explanations.length ? `<h2>Bugs explicados</h2>${m.explanations.map((e, i) => `
<div class="explain">
  <h3>${i + 1}. ${esc(e.title)} <a class="muted" href="#${esc(e.code)}">${esc(e.code)}</a></h3>
  <dl>
    <dt>Como ver</dt><dd>${esc(e.howToSee)}</dd>
    <dt>O que acontece</dt><dd>${esc(e.happens)}</dd>
    <dt>O que o card pede</dt><dd>${esc(e.expected)}</dd>
    ${e.note ? `<dt>Observação</dt><dd>${esc(e.note)}</dd>` : ''}
  </dl>
</div>`).join('')}` : ''}

${m.retest ? `<h2>Reteste de ${esc(m.retest.parent)}</h2><p>Corrigidos ${m.retest.fixed} · ainda falham ${m.retest.stillFailing} · regressões ${m.retest.regressed}</p>
<table class="cmp"><tr><th>Cenário</th><th>Antes</th><th>Agora</th></tr>${m.retest.rows.map((r) => `<tr><td>${esc(r.code)}</td><td>${badge(r.was)}</td><td>${badge(r.now)}</td></tr>`).join('')}</table>` : ''}

${m.videos.length ? `<h2>Vídeo da execução</h2>${m.videos.map((v, i) => `
<div class="video">
  <video id="v${i}" controls preload="metadata" src="${rel(v.path)}"></video>
  ${v.chapters.length ? `<div class="chapters">${v.chapters.map((ch) => seek(v.path, ch.atSec, `${ch.code} ${clock(ch.atSec)}`)).join('')}</div>` : ''}
  <div class="muted">${esc(v.path)}</div>
</div>`).join('')}` : ''}

<h2>Cenários</h2>
${m.scenarios.map(scenarioHtml).join('')}

${section('Reclassificações', m.reclassified)}
${section('Action Guard', m.guard)}
${section('Dados criados e limpeza', m.cleanup)}
${section('Pontos em aberto do card', m.openQuestions)}
${section('Métricas', m.metrics)}

<h2>Rascunho de comentário para o Jira <span class="muted">(não publicado)</span></h2>
<pre>${esc(m.jiraDraft)}</pre>
</main>
<script>
function seek(id, t) {
  var v = document.getElementById(id);
  if (!v) return;
  v.currentTime = t;
  v.scrollIntoView({ behavior: 'smooth', block: 'center' });
  v.play();
}
</script>
</body></html>`;
}
