import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/load.ts';
import { computeRunMetrics, formatMetrics } from '../src/metrics/run-metrics.ts';
import { ingestTranscripts, parseTranscript, transcriptDirs } from '../src/metrics/transcripts.ts';
import { Redactor } from '../src/security/redact.ts';
import { openDb, type Db } from '../src/state/db.ts';
import { StateStore } from '../src/state/store.ts';

/** Uma chamada ao modelo como o Claude Code grava: uma linha por bloco, mesmo message.id. */
function call(session: string, id: string, ts: string, usage: { i: number; o: number; r?: number; w?: number }, tools: string[] = [], extra = {}) {
  const u = { input_tokens: usage.i, output_tokens: usage.o, cache_read_input_tokens: usage.r ?? 0, cache_creation_input_tokens: usage.w ?? 0 };
  const base = { type: 'assistant', sessionId: session, timestamp: ts, isSidechain: false, ...extra };
  const lines = [JSON.stringify({ ...base, message: { id, model: 'claude-opus-5-5', usage: { ...u, output_tokens: 1 }, content: [{ type: 'thinking' }] } })];
  for (const name of tools) lines.push(JSON.stringify({ ...base, message: { id, model: 'claude-opus-5-5', usage: u, content: [{ type: 'tool_use', name }] } }));
  if (!tools.length) lines.push(JSON.stringify({ ...base, message: { id, model: 'claude-opus-5-5', usage: u, content: [{ type: 'text' }] } }));
  return lines.join('\n');
}

describe('parseTranscript', () => {
  it('deduplica por message.id, junta ferramentas, ignora linha truncada e não-assistant', () => {
    const text = [
      call('S1', 'm1', '2026-10-23T10:00:00.000Z', { i: 10, o: 100, r: 5000, w: 300 }, ['mcp__novo-qa__act', 'mcp__novo-qa__verify']),
      JSON.stringify({ type: 'user', sessionId: 'S1', timestamp: '2026-10-23T10:00:01.000Z', message: { content: 'oi' } }),
      '{"type":"assistant","sessionId":"S1"', // truncada
      call('S1', 'm2', '2026-10-23T10:00:02.000Z', { i: 5, o: 50 }, [], { isSidechain: true }),
    ].join('\n');
    const calls = parseTranscript(text);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ messageId: 'm1', sidechain: false, usage: { input_tokens: 10, output_tokens: 100, cache_read_input_tokens: 5000, cache_creation_input_tokens: 300 } });
    expect([...calls[0]!.tools]).toEqual(['mcp__novo-qa__act', 'mcp__novo-qa__verify']);
    expect(calls[1]).toMatchObject({ messageId: 'm2', sidechain: true });
  });
});

describe('ingestão e atribuição por run', () => {
  let root: string;
  let db: Db;
  let store: StateStore;
  let clock: Date;
  const at = (iso: string) => { clock = new Date(iso); };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'novo-qa-metrics-'));
    db = openDb(':memory:');
    clock = new Date('2026-10-23T10:00:00Z');
    store = new StateStore(db, loadConfig(join(import.meta.dirname, '..')), { now: () => clock });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('acha a pasta do projeto ignorando caixa da letra do drive', () => {
    const home = join(root, 'home');
    mkdirSync(join(home, '.claude', 'projects', 'C--Users-ana-NEW-QA'), { recursive: true });
    expect(transcriptDirs('c:\\Users\\ana\\NEW QA', home)).toEqual([join(home, '.claude', 'projects', 'C--Users-ana-NEW-QA')]);
  });

  it('atribui tokens ao run, aos cenários e ignora sessões e horários de fora', () => {
    // descoberta (antes do run_start) → run → cenários
    at('2026-10-23T09:55:00Z');
    store.logEvent(null, null, 'cache.miss', { source: 'jira', key: 'FIX-80' });
    store.logEvent(null, null, 'context.build', { issueKey: 'FIX-80', approxTokens: 800 });
    at('2026-10-23T10:00:00Z');
    const run = store.startRun({ issueKey: 'FIX-80', env: 'fixture-local', mode: 'manual' });
    store.savePlan(run.id, ['CT-001', 'CT-002'].map((code) => ({ code, title: code, priority: 'P1' as const, risk: 'HIGH' as const, types: [], steps: ['x'], expected: 'yyy' })));
    store.approvePlan(run.id);
    at('2026-10-23T10:10:00Z');
    store.startScenario(run.id, 'CT-001');
    store.recordVerification(run.id, 'CT-001', { kind: 'ui', description: 'a', passed: true });
    at('2026-10-23T10:20:00Z');
    store.completeScenario(run.id, 'CT-001', { status: 'PASSED' });
    at('2026-10-23T10:30:00Z');
    store.startScenario(run.id, 'CT-002');
    store.recordVerification(run.id, 'CT-002', { kind: 'ui', description: 'b', passed: false });
    store.recordEvidence(run.id, 'CT-002', { kind: 'screenshot', path: 'x.png' });
    store.logEvent(run.id, store.getScenario(run.id, 'CT-002').id, 'inspect.network', null);
    at('2026-10-23T10:40:00Z');
    store.completeScenario(run.id, 'CT-002', { status: 'FAILED', classification: 'PRODUCT_BUG', observed: 'quebrou' });
    at('2026-10-23T10:50:00Z');
    store.completeRun(run.id, 'REPROVADO', 'um bug');

    const dir = join(root, 'transcripts');
    mkdirSync(join(dir, 'S1', 'subagents'), { recursive: true });
    writeFileSync(join(dir, 'S1.jsonl'), [
      call('S1', 'd1', '2026-10-23T09:56:00.000Z', { i: 100, o: 200, r: 1000, w: 50 }, ['mcp__novo-qa__context_build']), // descoberta
      call('S1', 'p1', '2026-10-23T10:05:00.000Z', { i: 10, o: 300 }, ['mcp__novo-qa__plan_save']),
      call('S1', 'old', '2026-10-23T08:00:00.000Z', { i: 999, o: 999 }, ['mcp__novo-qa__run_status']), // fora da janela
    ].join('\n'));
    writeFileSync(join(dir, 'S1', 'subagents', 'agent-a.jsonl'), [
      call('S1', 'e1', '2026-10-23T10:15:00.000Z', { i: 20, o: 400, r: 2000 }, ['mcp__novo-qa__act']), // CT-001
      call('S1', 'e2', '2026-10-23T10:35:00.000Z', { i: 30, o: 600 }, ['mcp__novo-qa__verify']), // CT-002
    ].join('\n'));
    // Outra sessão no mesmo horário, sem ferramentas do NOVO QA: não conta.
    writeFileSync(join(dir, 'S2.jsonl'), call('S2', 'x1', '2026-10-23T10:15:00.000Z', { i: 5000, o: 5000 }, ['Bash']));

    expect(ingestTranscripts(db, [dir])).toEqual({ files: 3, calls: 6 });
    expect(ingestTranscripts(db, [dir]).calls).toBe(6); // idempotente
    expect(db.prepare('SELECT COUNT(*) AS n FROM model_usage').get()).toEqual({ n: 6 });

    const m = computeRunMetrics(db, store, run.id);
    expect(m.window).toEqual({ start: '2026-10-23T09:55:00.000Z', end: '2026-10-23T10:50:00.000Z', minutes: 55 });
    expect(m.model).toMatchObject({ sessions: 1, calls: 4, subagentCalls: 2 });
    expect(m.model.tokens).toEqual({ input: 160, cacheRead: 3000, cacheWrite: 50, output: 1500, fresh: 1710 });
    expect(m.perScenario.costliest).toEqual([
      { code: 'CT-002', status: 'FAILED', minutes: 10, calls: 1, fresh: 630 },
      { code: 'CT-001', status: 'PASSED', minutes: 10, calls: 1, fresh: 420 },
    ]);
    expect(m.perScenario).toMatchObject({ avgFresh: 525, avgMinutes: 10 });
    expect(m.bugs).toBe(1);
    expect(m.perBug).toBe(1710);
    expect(m.decisions).toEqual({ total: 4, scenariosFinished: 2, verifications: 2, exploratory: 0 });
    expect(m.perDecision).toBe(428);
    expect(m.cache).toEqual({ hits: 0, misses: 1, stale: 0, hitRate: 0 });
    expect(m.deterministic.screenshots).toBe(1);
    expect(formatMetrics(m)[0]).toBe('Uso do modelo: 1710 tokens novos (entrada 160 · escrita cache 50 · saída 1500) + 3000 lidos do cache');
    // A linha passa pela sanitização sem perder o número (antes "Tokens: N" era lido como par token=valor).
    expect(new Redactor().text(formatMetrics(m)[0]!)).toBe(formatMetrics(m)[0]);
  });

  it('a janela do segundo run do mesmo card começa depois do fim do primeiro', () => {
    at('2026-10-23T09:00:00Z');
    store.logEvent(null, null, 'context.build', { issueKey: 'FIX-82', approxTokens: 800 });
    const first = store.startRun({ issueKey: 'FIX-82', env: 'fixture-local', mode: 'manual' });
    store.abortRun(first.id, 'primeiro run encerrado');
    at('2026-10-23T09:30:00Z');
    const second = store.startRun({ issueKey: 'FIX-82', env: 'fixture-local', mode: 'manual' });
    // A descoberta das 09:00 pertence ao primeiro run: a janela do segundo começa no seu run_start.
    expect(computeRunMetrics(db, store, second.id).window.start).toBe('2026-10-23T09:30:00.000Z');
  });

  it('sem transcripts, diz que não há uso atribuído em vez de mostrar zero como se fosse medido', () => {
    const run = store.startRun({ issueKey: 'FIX-81', env: 'fixture-local', mode: 'manual' });
    const lines = formatMetrics(computeRunMetrics(db, store, run.id));
    expect(lines.at(-1)).toMatch(/sem uso de modelo atribuído/);
  });
});
