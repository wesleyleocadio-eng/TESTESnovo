import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { BrowserService } from '../src/browser/service.ts';
import { loadConfig } from '../src/config/load.ts';
import type { Config, Environment } from '../src/config/schema.ts';
import { createServer } from '../src/mcp/server.ts';
import { Redactor } from '../src/security/redact.ts';
import { SecretStore } from '../src/security/secrets.ts';
import { openDb, type Db } from '../src/state/db.ts';
import { StateStore } from '../src/state/store.ts';
import { startFixtureServer, type FixtureServer } from './fixture-app/server.ts';

export const PASSWORD = 'Fx!segredo-2026';

export interface Harness {
  fixture: FixtureServer;
  root: string;
  db: Db;
  store: StateStore;
  browser: BrowserService;
  config: Config;
  secrets: SecretStore;
  redactor: Redactor;
  /** Todas as respostas recebidas, para varredura de vazamento. */
  transcript: string[];
  call(name: string, args?: Record<string, unknown>): Promise<{ isError: boolean; text: string; json?: Record<string, any>; content: any[] }>;
  ok(name: string, args?: Record<string, unknown>): Promise<Record<string, any>>;
  close(): Promise<void>;
}

/** Cliente MCP real → servidor novo-qa → Chromium headless → app fixture local. */
export async function createHarness(env: Partial<Environment> = {}): Promise<Harness> {
  const fixture = await startFixtureServer({ password: PASSWORD });
  const root = mkdtempSync(join(tmpdir(), 'novo-qa-e2e-'));
  const config = loadConfig(join(import.meta.dirname, '..'));
  Object.assign(config.environments['fixture-local']!, { baseUrl: fixture.url, ...env });
  config.projects.fixture!.jiraKeys = ['FIX'];
  const secrets = SecretStore.fromConfig(config, { FIXTURE_ADMIN_PASSWORD: PASSWORD });
  const redactor = new Redactor({ secrets: secrets.valuesForRedaction() });
  const db = openDb(':memory:');
  const store = new StateStore(db, config);
  const browser = new BrowserService({ rootDir: root, config, store, secrets, redactor });
  const client = await connect({ store, redactor, rootDir: root, config, db, secrets, browser, automationBaseUrl: fixture.url });

  const transcript: string[] = [];
  const call: Harness['call'] = async (name, args = {}) => {
    const result = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: any[] };
    transcript.push(JSON.stringify(result.content));
    const text = (result.content[0] as { text: string }).text;
    let json: Record<string, any> | undefined;
    if (!result.isError) {
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined; // resposta em YAML (context_build, batch_brief)
      }
    }
    return { isError: result.isError ?? false, text, json, content: result.content };
  };
  const ok: Harness['ok'] = async (name, args = {}) => {
    const r = await call(name, args);
    if (r.isError) throw new Error(`${name} falhou: ${r.text}`);
    return r.json!;
  };

  const harness: Harness = {
    fixture, root, db, store, browser, config, secrets, redactor, transcript, call, ok,
    close: async () => {
      await harness.browser.close(); // o atual: restart() troca o navegador
      await fixture.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
  return harness;
}

async function connect(deps: Parameters<typeof createServer>[0]): Promise<Client> {
  const server = createServer(deps);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(a);
  return client;
}

/**
 * Simula reinício (crash, Claude Code fechado): servidor e navegador novos sobre o mesmo
 * banco e os mesmos arquivos. Devolve um `ok` ligado ao novo servidor.
 */
export async function restart(h: Harness): Promise<{ ok: Harness['ok']; call: Harness['call']; browser: BrowserService }> {
  await h.browser.close();
  const store = new StateStore(h.db, h.config);
  const browser = new BrowserService({ rootDir: h.root, config: h.config, store, secrets: h.secrets, redactor: h.redactor });
  const client = await connect({ store, redactor: h.redactor, rootDir: h.root, config: h.config, db: h.db, secrets: h.secrets, browser });
  const call: Harness['call'] = async (name, args = {}) => {
    const result = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: any[] };
    const text = (result.content[0] as { text: string }).text;
    let json: Record<string, any> | undefined;
    try { json = result.isError ? undefined : JSON.parse(text); } catch { json = undefined; }
    return { isError: result.isError ?? false, text, json, content: result.content };
  };
  const ok: Harness['ok'] = async (name, args = {}) => {
    const r = await call(name, args);
    if (r.isError) throw new Error(`${name} falhou: ${r.text}`);
    return r.json ?? { text: r.text };
  };
  h.browser = browser;
  return { ok, call, browser };
}

/** Run com plano aprovado, navegador aberto e logado como admin. */
export async function loggedInRun(h: Harness, issueKey: string, codes: string[]): Promise<string> {
  const runId = (await h.ok('run_start', { issueKey, env: 'fixture-local', mode: 'manual' })).runId as string;
  await h.ok('plan_save', {
    runId,
    scenarios: codes.map((code) => ({ code, title: `Cenário ${code}`, priority: 'P2', risk: 'MEDIUM', types: ['functional'], steps: ['executar'], expected: 'resultado esperado' })),
  });
  await h.ok('plan_approve', { runId });
  await h.ok('browser_open', { runId, role: 'admin' });
  await h.ok('act', { action: 'fill', target: { label: 'Usuário' }, valueRef: 'role:admin.username' });
  await h.ok('act', { action: 'fill', target: { label: 'Senha' }, valueRef: 'role:admin.password' });
  await h.ok('act', { action: 'click', target: { role: 'button', name: 'Entrar' } });
  return runId;
}
