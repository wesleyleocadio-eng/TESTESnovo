import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { z } from 'zod';
import { BrowserError } from '../browser/service.ts';
import { TargetError } from '../browser/target.ts';
import { ConfigError } from '../config/load.ts';
import { ContextError } from '../context/package.ts';
import { KnowledgeError } from '../knowledge/staging.ts';
import { GuardError } from '../guard/guard.ts';
import { DigestError } from '../sources/digest.ts';
import type { Redactor } from '../security/redact.ts';
import { SecretError } from '../security/secrets.ts';
import { StateError, type StateStore } from '../state/store.ts';

export type Shape = Record<string, z.ZodType>;
export type ToolHandler<S extends Shape> = (args: z.infer<z.ZodObject<S>>) => unknown;
export type RegisterTool = <S extends Shape>(name: string, description: string, shape: S, handler: ToolHandler<S>) => void;

/** Resultado com conteúdo MCP próprio (ex.: imagem), em vez de JSON. */
export class ToolContent {
  constructor(readonly content: CallToolResult['content']) {}
}

const KNOWN_ERRORS = [StateError, SecretError, BrowserError, TargetError, GuardError, DigestError, ContextError, KnowledgeError, ConfigError];

/**
 * Registro comum: entrada e saída sanitizadas, erros de regra devolvidos como mensagem
 * (não exceção) e um evento por chamada (base das métricas).
 */
export function createRegistrar(server: McpServer, deps: { store: StateStore; redactor: Redactor }): RegisterTool {
  const { store, redactor } = deps;
  return (name, description, shape, handler) => {
    const callback = async (rawArgs: unknown): Promise<CallToolResult> => {
      const args = redactor.value(rawArgs) as Parameters<typeof handler>[0];
      const runId = (args as { runId?: unknown }).runId;
      store.logEvent(typeof runId === 'string' ? runId : null, null, `tool.${name}`, null);
      try {
        const result = await handler(args);
        if (result instanceof ToolContent) {
          return { content: result.content.map((c) => (c.type === 'text' ? { ...c, text: redactor.text(c.text) } : c)) };
        }
        return { content: [{ type: 'text', text: JSON.stringify(redactor.value(result)) }] };
      } catch (err) {
        const known = KNOWN_ERRORS.some((E) => err instanceof E);
        const first = ((err as Error).message ?? String(err)).split('\n').slice(0, known ? 12 : 1).join('\n');
        const message = known ? first : `erro: ${first.slice(0, 500)}`;
        return { isError: true, content: [{ type: 'text', text: redactor.text(message) }] };
      }
    };
    // O SDK infere o tipo dos args a partir do shape; com o shape genérico essa inferência
    // não fecha, e a validação real (zod) acontece no SDK antes do callback.
    server.registerTool(name, { description, inputSchema: shape }, callback as never);
  };
}
