import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/load.ts';
import { createServer } from '../src/mcp/server.ts';
import { Redactor } from '../src/security/redact.ts';
import { openDb, type Db } from '../src/state/db.ts';
import { StateStore } from '../src/state/store.ts';

const config = loadConfig(join(import.meta.dirname, '..'));
const SECRET = 'segredo-do-fixture-123';

let client: Client;
let store: StateStore;
let db: Db;

beforeEach(async () => {
  db = openDb(':memory:');
  store = new StateStore(db, config);
  const redactor = new Redactor({ secrets: [{ name: 'FIXTURE_ADMIN_PASSWORD', value: SECRET }] });
  const server = createServer({ store, redactor, rootDir: join(import.meta.dirname, '..') });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: 'test', version: '0' });
  await client.connect(clientTransport);
});

async function call(name: string, args: Record<string, unknown>) {
  const result = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
  const text = result.content[0]!.text;
  return { isError: result.isError ?? false, text, json: result.isError ? undefined : JSON.parse(text) };
}

describe('servidor MCP novo-qa', () => {
  it('expõe só as ferramentas de estado — verificações não são registráveis pelo modelo', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'plan_approve', 'plan_save', 'run_abort', 'run_complete', 'run_start', 'run_status',
      'scenario_add', 'scenario_complete', 'scenario_reclassify', 'scenario_reopen', 'scenario_start',
    ]);
  });

  it('fluxo via MCP: PASS sem verificação volta como erro de regra', async () => {
    const start = await call('run_start', { issueKey: 'FIX-1', env: 'fixture-local', mode: 'manual' });
    const runId = start.json.runId as string;
    const plan = { code: 'CT-001', title: 'Login válido', priority: 'P0', risk: 'HIGH', types: ['functional'], steps: ['logar'], expected: 'dashboard' };
    expect((await call('plan_save', { runId, scenarios: [plan] })).json.status).toBe('AWAITING_APPROVAL');

    const early = await call('scenario_start', { runId, code: 'CT-001' });
    expect(early.isError).toBe(true);
    expect(early.text).toMatch(/aguardando aprovação/);

    await call('plan_approve', { runId });
    await call('scenario_start', { runId, code: 'CT-001' });
    const pass = await call('scenario_complete', { runId, code: 'CT-001', status: 'PASSED' });
    expect(pass.isError).toBe(true);
    expect(pass.text).toMatch(/verificação aprovada/);

    store.recordVerification(runId, 'CT-001', { kind: 'url', description: 'em /dashboard', passed: true });
    const ok = await call('scenario_complete', { runId, code: 'CT-001', status: 'PASSED' });
    expect(ok.json).toMatchObject({ status: 'PASSED', confidence: 'LOW', progress: '1/1' });

    const status = await call('run_status', { runIdOrKey: 'FIX-1' });
    expect(status.json.counts).toEqual({ PASSED: 1 });
  });

  it('valida entrada pelo schema', async () => {
    const bad = await call('run_start', { issueKey: 'sem-formato', env: 'fixture-local', mode: 'manual' });
    expect(bad.isError).toBe(true);
  });

  it('sanitiza o que entra e o que sai', async () => {
    const { json } = await call('run_start', { issueKey: 'FIX-2', env: 'fixture-local', mode: 'manual' });
    const res = await call('run_abort', { runId: json.runId, reason: `ambiente caiu; senha=${SECRET}` });
    expect(res.text).not.toContain(SECRET);
    const stored = store.getRun(json.runId).summary!;
    expect(stored).not.toContain(SECRET);
  });

  it('registra evento por chamada de ferramenta (base de métricas)', async () => {
    const { json } = await call('run_start', { issueKey: 'FIX-3', env: 'fixture-local', mode: 'manual' });
    await call('run_abort', { runId: json.runId, reason: 'fim do teste' });
    const rows = db.prepare("SELECT type, run_id FROM events WHERE type LIKE 'tool.%' ORDER BY id").all();
    expect(rows).toEqual([
      { type: 'tool.run_start', run_id: null },
      { type: 'tool.run_abort', run_id: json.runId },
    ]);
  });
});
