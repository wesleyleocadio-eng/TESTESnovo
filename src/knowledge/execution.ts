import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { toPlaywrightCode, type Target } from '../browser/target.ts';
import { runDir } from '../evidence/files.ts';
import { projectDir } from './modules.ts';
import type { RunRow, StateStore } from '../state/store.ts';

export interface ExecutionEntry {
  route: string;
  action: string;
  target: Target | { url: string };
  /** Linha Playwright equivalente — reaproveitada na geração da automação. */
  playwright: string;
  valueType?: string;
  scenario: string;
  validatedIn: string[];
  lastSeen: string;
}

function valueTypeOf(ref: string | null): string | undefined {
  if (!ref) return undefined;
  if (ref.startsWith('type:')) return ref.slice(5);
  if (ref.startsWith('secret:')) return 'secret';
  if (ref.startsWith('key:')) return undefined;
  const role = /^role:[^.]+\.(username|password)$/.exec(ref);
  return role ? role[1] : undefined;
}

export function playwrightLine(action: string, target: Target | { url: string }, ref: string | null): string {
  if (action === 'navigate') return `await page.goto('${(target as { url: string }).url}');`;
  const loc = toPlaywrightCode(target as Target);
  const valueType = valueTypeOf(ref);
  const arg = valueType ? `<${valueType}>` : '<valor>';
  switch (action) {
    case 'fill': return `await ${loc}.fill(${arg});`;
    case 'select': return `await ${loc}.selectOption(${arg});`;
    case 'press': return `await ${loc}.press('${ref?.startsWith('key:') ? ref.slice(4) : 'Enter'}');`;
    case 'upload': return `await ${loc}.setInputFiles(<arquivos>);`;
    default: return `await ${loc}.${action}();`;
  }
}

export function buildExecutionKnowledge(store: StateStore, run: RunRow): ExecutionEntry[] {
  const seen = new Map<string, ExecutionEntry>();
  for (const row of store.validatedActions(run.id)) {
    const target = JSON.parse(row.target_json ?? '{}') as Target | { url: string };
    const route = row.url ? new URL(row.url).pathname : '';
    const key = `${route}|${row.action}|${row.target_json}`;
    if (seen.has(key)) continue;
    const valueType = valueTypeOf(row.value_ref);
    seen.set(key, {
      route,
      action: row.action,
      target,
      playwright: playwrightLine(row.action, target, row.value_ref),
      ...(valueType ? { valueType } : {}),
      scenario: row.scenario,
      validatedIn: [run.id],
      lastSeen: row.ts.slice(0, 10),
    });
  }
  return [...seen.values()];
}

const MAX_VALIDATED_IN = 5;

/**
 * Funde entradas validadas em knowledge/<projeto>/execution/<módulo>.json: mesma rota+ação+alvo
 * acumula runs (os 5 mais recentes) e atualiza lastSeen; o resto é acrescentado.
 */
export function mergeExecutionKnowledge(rootDir: string, project: string, module: string, entries: ExecutionEntry[]) {
  const dir = join(projectDir(rootDir, project), 'execution');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${module}.json`);
  const current = existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as ExecutionEntry[]) : [];
  const key = (e: ExecutionEntry) => `${e.route}|${e.action}|${JSON.stringify(e.target)}`;
  const byKey = new Map(current.map((e) => [key(e), e]));
  let added = 0;
  for (const e of entries) {
    const existing = byKey.get(key(e));
    if (existing) {
      existing.validatedIn = [...new Set([...e.validatedIn, ...existing.validatedIn])].slice(0, MAX_VALIDATED_IN);
      existing.lastSeen = e.lastSeen > existing.lastSeen ? e.lastSeen : existing.lastSeen;
      if (e.valueType) existing.valueType = e.valueType;
    } else {
      byKey.set(key(e), e);
      added++;
    }
  }
  writeFileSync(path, `${JSON.stringify([...byKey.values()], null, 2)}\n`);
  return { file: `knowledge/${project}/execution/${module}.json`, added, total: byKey.size };
}

/**
 * Grava runs/<card>/<runId>/execution-knowledge.json e, se o run tem módulo,
 * funde no execution knowledge do módulo principal (o primeiro).
 */
export function writeExecutionKnowledge(rootDir: string, store: StateStore, run: RunRow) {
  const entries = buildExecutionKnowledge(store, run);
  const dir = runDir(rootDir, run.issue_key, run.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'execution-knowledge.json'), `${JSON.stringify(entries, null, 2)}\n`);
  const [module] = JSON.parse(run.modules) as string[];
  const merged = module && entries.length ? mergeExecutionKnowledge(rootDir, run.project, module, entries) : undefined;
  return { path: `runs/${run.issue_key}/${run.id}/execution-knowledge.json`, entries: entries.length, ...(merged ? { merged } : {}) };
}

/** Execution knowledge salvo dos módulos, em linhas Playwright compactas (para o briefing do executor). */
export function executionHints(rootDir: string, project: string, modules: string[], max = 40): string[] {
  const lines: string[] = [];
  for (const m of modules) {
    const path = join(projectDir(rootDir, project), 'execution', `${m}.json`);
    if (!existsSync(path)) continue;
    for (const e of JSON.parse(readFileSync(path, 'utf8')) as ExecutionEntry[]) lines.push(`${e.route}: ${e.playwright}`);
  }
  return lines.slice(0, max);
}
