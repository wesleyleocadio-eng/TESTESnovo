import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { config as loadDotEnv } from 'dotenv';
import { BrowserService } from './browser/service.ts';
import { loadConfig } from './config/load.ts';
import { runDoctor, type CheckStatus } from './doctor/checks.ts';
import { createServer } from './mcp/server.ts';
import { computeRunMetrics, formatMetrics } from './metrics/run-metrics.ts';
import { ingestTranscripts, transcriptDirs } from './metrics/transcripts.ts';
import { Redactor } from './security/redact.ts';
import { SecretStore } from './security/secrets.ts';
import { openDb } from './state/db.ts';
import { StateStore } from './state/store.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const ICON: Record<CheckStatus, string> = { ok: '✓', warn: '!', fail: '✗' };

function doctor(): number {
  loadDotEnv({ path: join(ROOT, '.env'), quiet: true });
  const results = runDoctor({ rootDir: ROOT, homeDir: homedir(), env: process.env, nodeVersion: process.version });
  const width = Math.max(...results.map((r) => r.name.length));
  for (const r of results) console.log(`${ICON[r.status]} ${r.name.padEnd(width)}  ${r.detail}`);
  const fails = results.filter((r) => r.status === 'fail').length;
  const warns = results.filter((r) => r.status === 'warn').length;
  console.log(`\n${fails} falha(s), ${warns} aviso(s)`);
  return fails > 0 ? 1 : 0;
}

/** novo-qa metrics <runId|card>  ·  novo-qa metrics --schema */
async function metrics(arg?: string): Promise<number> {
  const config = loadConfig(ROOT);
  if (arg === '--schema') return schema(config);
  if (!arg) {
    console.log('Uso: novo-qa metrics <runId|card> | --schema');
    return 1;
  }
  const db = openDb(process.env.NOVO_QA_DB ?? join(ROOT, 'data', 'novo-qa.db'));
  const store = new StateStore(db, config);
  const ingested = ingestTranscripts(db, transcriptDirs(ROOT, homedir(), process.env.NOVO_QA_TRANSCRIPTS_DIR || undefined));
  const run = store.resolveRun(arg);
  const m = computeRunMetrics(db, store, run.id);
  console.log(`${run.issue_key} · ${run.id} (${ingested.calls} chamadas lidas de ${ingested.files} transcript(s))\n`);
  for (const line of formatMetrics(m)) console.log(line);
  if (m.perScenario.costliest.length) {
    console.log('\nCenários mais caros:');
    for (const c of m.perScenario.costliest) console.log(`  ${c.code.padEnd(8)} ${String(c.fresh).padStart(8)} tokens  ${String(c.calls).padStart(3)} chamadas  ${c.minutes} min  ${c.status}`);
  }
  return 0;
}

/** Custo fixo das ferramentas: tamanho do schema de cada uma, como o modelo recebe. */
async function schema(config: ReturnType<typeof loadConfig>): Promise<number> {
  const db = openDb(':memory:');
  const store = new StateStore(db, config);
  const secrets = SecretStore.fromConfig(config, {});
  const redactor = new Redactor();
  const browser = new BrowserService({ rootDir: ROOT, config, store, secrets, redactor });
  const server = createServer({ store, redactor, rootDir: ROOT, config, db, secrets, browser });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  const client = new Client({ name: 'cli', version: '0' });
  await client.connect(a);
  const { tools } = await client.listTools();
  const sizes = tools.map((t) => ({ name: t.name, tokens: Math.ceil(JSON.stringify(t).length / 4) })).sort((x, y) => y.tokens - x.tokens);
  for (const s of sizes) console.log(`${s.name.padEnd(20)} ~${s.tokens}`);
  console.log(`\n${tools.length} ferramentas · ~${sizes.reduce((acc, s) => acc + s.tokens, 0)} tokens de schema (estimativa: caracteres/4)`);
  return 0;
}

const commands: Record<string, (arg?: string) => number | Promise<number>> = { doctor, metrics };

const [command = 'help', arg] = process.argv.slice(2);
const run = commands[command];
if (!run) {
  console.log(`Uso: novo-qa <comando>\n\nComandos:\n  doctor\n  metrics <runId|card> | --schema`);
  process.exit(command === 'help' ? 0 : 1);
}
process.exit(await run(arg));
