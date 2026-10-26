import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { config as loadDotEnv } from 'dotenv';
import { BrowserService } from '../browser/service.ts';
import { loadConfig } from '../config/load.ts';
import { transcriptDirs } from '../metrics/transcripts.ts';
import { Redactor } from '../security/redact.ts';
import { SecretStore } from '../security/secrets.ts';
import { openDb } from '../state/db.ts';
import { StateStore } from '../state/store.ts';
import { createServer } from './server.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

loadDotEnv({ path: join(ROOT, '.env'), quiet: true });
const config = loadConfig(ROOT);
const secrets = SecretStore.fromConfig(config);
const redactor = new Redactor({
  secrets: secrets.valuesForRedaction(),
  extraSensitiveKeys: config.policy.redaction.extraSensitiveKeys,
});
const db = openDb(process.env.NOVO_QA_DB ?? join(ROOT, 'data', 'novo-qa.db'));
const store = new StateStore(db, config);
const browser = new BrowserService({
  rootDir: ROOT, config, store, secrets, redactor, channel: process.env.NOVO_QA_BROWSER_CHANNEL || undefined,
});
const transcripts = transcriptDirs(ROOT, homedir(), process.env.NOVO_QA_TRANSCRIPTS_DIR || undefined);
const server = createServer({ store, redactor, rootDir: ROOT, config, db, secrets, browser, transcriptDirs: transcripts });

// Não deixar navegador órfão quando o Claude Code encerra o servidor.
const shutdown = async () => {
  await browser.close();
  db.close();
  process.exit(0);
};
process.stdin.on('close', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// stdout é o canal MCP: nada de console.log aqui.
await server.connect(new StdioServerTransport());
