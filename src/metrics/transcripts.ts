import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from '../state/db.ts';

/**
 * Ingestão do uso de modelo a partir dos transcripts JSONL do Claude Code
 * (~/.claude/projects/<projeto>/*.jsonl). Cada chamada ao modelo aparece em várias
 * linhas (uma por bloco de conteúdo) com o mesmo message.id: deduplica por id.
 * O formato não é API pública — tudo que depende dele fica isolado aqui.
 */

interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface TranscriptLine {
  type?: string;
  sessionId?: string;
  timestamp?: string;
  isSidechain?: boolean;
  agentId?: string;
  message?: { id?: string; model?: string; usage?: Usage; content?: { type?: string; name?: string }[] | string };
}

/** Pastas de transcript do projeto: o nome é o caminho com tudo que não é letra/dígito trocado por "-". */
export function transcriptDirs(rootDir: string, homeDir: string, override?: string): string[] {
  if (override) return existsSync(override) ? [override] : [];
  const base = join(homeDir, '.claude', 'projects');
  if (!existsSync(base)) return [];
  const slug = rootDir.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
  return readdirSync(base).filter((d) => d.toLowerCase() === slug).map((d) => join(base, d));
}

function jsonlFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (name === 'memory' || name === 'tool-results') continue;
    if (statSync(path).isDirectory()) out.push(...jsonlFiles(path));
    else if (name.endsWith('.jsonl')) out.push(path);
  }
  return out;
}

interface Call {
  messageId: string;
  sessionId: string;
  ts: string;
  model: string | null;
  sidechain: boolean;
  usage: Required<Usage>;
  tools: Set<string>;
}

export function parseTranscript(text: string, fileIsSubagent = false): Call[] {
  const calls = new Map<string, Call>();
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue;
    let line: TranscriptLine;
    try {
      line = JSON.parse(raw) as TranscriptLine;
    } catch {
      continue; // linha truncada (arquivo sendo escrito)
    }
    const id = line.message?.id;
    const usage = line.message?.usage;
    if (line.type !== 'assistant' || !id || !usage || !line.sessionId || !line.timestamp) continue;
    const call = calls.get(id) ?? {
      messageId: id, sessionId: line.sessionId, ts: line.timestamp, model: line.message?.model ?? null,
      sidechain: fileIsSubagent || line.isSidechain === true || line.agentId !== undefined,
      usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      tools: new Set<string>(),
    };
    // As linhas de uma mesma chamada repetem o usage; a última é a completa.
    call.usage = {
      input_tokens: usage.input_tokens ?? 0,
      output_tokens: Math.max(call.usage.output_tokens, usage.output_tokens ?? 0),
      cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
      cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
    };
    if (Array.isArray(line.message?.content)) {
      for (const block of line.message.content) if (block.type === 'tool_use' && block.name) call.tools.add(block.name);
    }
    calls.set(id, call);
  }
  return [...calls.values()];
}

/** Lê os transcripts e grava/atualiza uma linha por chamada ao modelo. Idempotente. */
export function ingestTranscripts(db: Db, dirs: string[]): { files: number; calls: number } {
  const upsert = db.prepare(
    `INSERT INTO model_usage (session_id, agent, message_id, model, tools, sidechain, input, output, cache_read, cache_write, ts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (message_id) DO UPDATE SET tools = excluded.tools, input = excluded.input, output = excluded.output,
       cache_read = excluded.cache_read, cache_write = excluded.cache_write`,
  );
  let files = 0;
  let calls = 0;
  for (const dir of dirs) {
    for (const file of jsonlFiles(dir)) {
      files++;
      const isSub = /[\\/]subagents[\\/]/.test(file);
      for (const c of parseTranscript(readFileSync(file, 'utf8'), isSub)) {
        upsert.run(c.sessionId, c.sidechain ? 'subagent' : 'main', c.messageId, c.model, JSON.stringify([...c.tools]), c.sidechain ? 1 : 0,
          c.usage.input_tokens, c.usage.output_tokens, c.usage.cache_read_input_tokens, c.usage.cache_creation_input_tokens, c.ts);
        calls++;
      }
    }
  }
  return { files, calls };
}
