import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from '../state/db.ts';

/**
 * Executa a suíte gerada de um card (automation/<projeto>/tests/<card>) e interpreta o
 * relatório JSON do Playwright. Validação repete cada teste (--repeat-each=2): resultado
 * diferente entre repetições é flaky, não "passou".
 */

export type TestOutcome = 'passed' | 'failed' | 'flaky' | 'skipped';

export interface TestResult {
  file: string;
  title: string;
  scenario: string | null;
  status: TestOutcome;
  attempts: number;
  durationMs: number;
  error?: string;
  blocked?: string[];
}

export interface ParsedReport {
  tests: TestResult[];
  errors: string[];
}

interface JsonResult { status: string; duration: number; error?: { message?: string }; errors?: { message?: string }[] }
interface JsonTest { status: 'expected' | 'unexpected' | 'flaky' | 'skipped'; results: JsonResult[]; annotations?: { type: string; description?: string }[] }
interface JsonSpec { title: string; file: string; tests: JsonTest[] }
interface JsonSuite { suites?: JsonSuite[]; specs?: JsonSpec[] }
interface JsonReport { suites?: JsonSuite[]; errors?: { message?: string }[] }

const stripAnsi = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, '');

export function parseReport(json: JsonReport): ParsedReport {
  const bySpec = new Map<string, { spec: JsonSpec; tests: JsonTest[] }>();
  const walk = (suite: JsonSuite) => {
    for (const s of suite.suites ?? []) walk(s);
    for (const spec of suite.specs ?? []) {
      const key = `${spec.file}|${spec.title}`;
      const entry = bySpec.get(key) ?? { spec, tests: [] };
      entry.tests.push(...spec.tests);
      bySpec.set(key, entry);
    }
  };
  for (const s of json.suites ?? []) walk(s);

  const tests = [...bySpec.values()].map(({ spec, tests: runs }): TestResult => {
    const statuses = runs.map((t) => t.status);
    const status: TestOutcome =
      statuses.every((s) => s === 'skipped') ? 'skipped'
      : statuses.includes('flaky') || (statuses.includes('expected') && statuses.includes('unexpected')) ? 'flaky'
      : statuses.every((s) => s === 'expected' || s === 'skipped') ? 'passed'
      : 'failed';
    const results = runs.flatMap((t) => t.results);
    // Todos os erros do primeiro resultado com falha: o 1º costuma ser genérico ("Test timeout"), o seletor vem depois.
    const failing = results.find((r) => r.error || r.errors?.length);
    const firstError = failing
      ? [...new Set([failing.error?.message, ...(failing.errors ?? []).map((e) => e.message)].filter(Boolean))].join('\n')
      : undefined;
    const blocked = runs.flatMap((t) => (t.annotations ?? []).filter((a) => a.type === 'novo-qa-blocked').map((a) => a.description ?? ''));
    return {
      file: spec.file,
      title: spec.title,
      scenario: /^(CT-\d+|EXP-\d+)/.exec(spec.title)?.[1] ?? null,
      status,
      attempts: results.length,
      durationMs: results.reduce((acc, r) => acc + (r.duration ?? 0), 0),
      ...(firstError ? { error: stripAnsi(firstError).split('\n').slice(0, 12).join('\n').slice(0, 1500) } : {}),
      ...(blocked.length ? { blocked: [...new Set(blocked)] } : {}),
    };
  });
  return { tests, errors: (json.errors ?? []).map((e) => stripAnsi(e.message ?? '').slice(0, 1500)) };
}

export interface RunOptions {
  rootDir: string;
  project: string;
  issueKey: string;
  validation: boolean;
  envId?: string;
  grep?: string;
  /** Sobrescreve a baseUrl (ex.: porta dinâmica em teste). */
  baseUrl?: string;
  timeoutMs?: number;
}

export async function runPlaywright(o: RunOptions): Promise<{ exitCode: number | null; report: ParsedReport; reportPath: string; output: string }> {
  const cwd = join(o.rootDir, 'automation', o.project);
  const testsDir = join(cwd, 'tests', o.issueKey);
  if (!existsSync(testsDir)) throw new Error(`sem testes em automation/${o.project}/tests/${o.issueKey}`);
  const outDir = join(o.rootDir, 'runs', o.issueKey, 'automation');
  mkdirSync(outDir, { recursive: true });
  const reportPath = join(outDir, `report-${Date.now()}.json`);
  const cli = join(o.rootDir, 'node_modules', '@playwright', 'test', 'cli.js');

  const args = [cli, 'test', `tests/${o.issueKey}`, '--reporter=json', `--output=${join(outDir, 'test-results')}`];
  if (o.validation) args.push('--repeat-each=2');
  if (o.grep) args.push('--grep', o.grep);
  const env = {
    ...process.env,
    PLAYWRIGHT_JSON_OUTPUT_NAME: reportPath,
    ...(o.envId ? { NOVO_QA_ENV: o.envId } : {}),
    ...(o.baseUrl ? { NOVO_QA_BASE_URL: o.baseUrl } : {}),
  };

  let output = '';
  const exitCode = await new Promise<number | null>((resolve) => {
    const child = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => child.kill(), o.timeoutMs ?? 10 * 60_000);
    child.stdout.on('data', (d) => { output += d; });
    child.stderr.on('data', (d) => { output += d; });
    child.on('close', (code) => { clearTimeout(timer); resolve(code); });
  });

  const report = existsSync(reportPath)
    ? parseReport(JSON.parse(readFileSync(reportPath, 'utf8')) as JsonReport)
    : { tests: [], errors: [stripAnsi(output).slice(-1500) || 'Playwright não gerou relatório'] };
  return { exitCode, report, reportPath: `runs/${o.issueKey}/automation/${reportPath.split(/[\\/]/).pop()}`, output: stripAnsi(output).slice(-2000) };
}

export function recordAutomationRun(db: Db, r: { issueKey: string; project: string; runId: string | null; kind: 'attempt' | 'validation'; startedAt: string; endedAt: string; exitCode: number | null; reportPath: string; report: ParsedReport }): number {
  const count = (s: TestOutcome) => r.report.tests.filter((t) => t.status === s).length;
  const id = Number(
    db.prepare(
      `INSERT INTO automation_runs (issue_key, project, run_id, kind, started_at, ended_at, total, passed, failed, flaky, skipped, exit_code, report_path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(r.issueKey, r.project, r.runId, r.kind, r.startedAt, r.endedAt, r.report.tests.length, count('passed'), count('failed'), count('flaky'), count('skipped'), r.exitCode, r.reportPath).lastInsertRowid,
  );
  const insert = db.prepare(
    `INSERT INTO automation_tests (automation_run_id, file, title, scenario_code, status, attempts, duration_ms, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const t of r.report.tests) insert.run(id, t.file, t.title, t.scenario, t.status, t.attempts, t.durationMs, t.error ?? null);
  return id;
}
