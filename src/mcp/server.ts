import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BrowserService } from '../browser/service.ts';
import type { Config } from '../config/schema.ts';
import type { Redactor } from '../security/redact.ts';
import type { SecretStore } from '../security/secrets.ts';
import { DigestCache } from '../sources/digest.ts';
import type { Db } from '../state/db.ts';
import type { StateStore } from '../state/store.ts';
import { createRegistrar } from './tooling.ts';
import { registerAutomationTools } from './tools/automation.ts';
import { registerBrowserTools } from './tools/browser.ts';
import { registerContextTools } from './tools/context.ts';
import { registerQaTools } from './tools/qa.ts';
import { registerStateTools } from './tools/state.ts';

export interface ServerDeps {
  store: StateStore;
  redactor: Redactor;
  rootDir: string;
  /** Com config e db, expõe contexto (digests, Context Package) e fluxo /qa (lotes, relatório, conhecimento). */
  config?: Config;
  db?: Db;
  /** Habilita config_reload. */
  secrets?: SecretStore;
  /** Sem navegador, as ferramentas de navegador não são expostas. */
  browser?: BrowserService;
  /** Pastas de transcript do Claude Code (métricas de tokens). */
  transcriptDirs?: string[];
  /** Só para testes: baseUrl da suíte de automação (porta dinâmica do fixture). */
  automationBaseUrl?: string;
}

export function createServer(deps: ServerDeps): McpServer {
  const server = new McpServer({ name: 'novo-qa', version: '0.1.0' });
  const tool = createRegistrar(server, deps);
  registerStateTools(tool, deps);
  if (deps.config && deps.db) {
    const full = { ...deps, config: deps.config, db: deps.db, cache: new DigestCache(deps.db, deps.rootDir) };
    registerContextTools(tool, full);
    registerQaTools(tool, full);
    registerAutomationTools(tool, full);
  }
  if (deps.browser) registerBrowserTools(tool, deps.browser, deps.store);
  return server;
}
