import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { existsSync, readFileSync, watch } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

/**
 * Supervisor do servidor MCP: o Claude Code fala com este processo, que roda o servidor real
 * como filho e o reinicia sozinho quando o código em src/ muda — sem reconectar pelo /mcp.
 *
 * Reinício só em momento seguro: nenhuma chamada em andamento e navegador fechado (o servidor
 * mantém um arquivo de trava enquanto há navegador aberto). Depois de reiniciar, repete o
 * handshake (initialize) com o filho novo e avisa o cliente que a lista de ferramentas mudou.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WATCH_DIR = process.env.NOVO_QA_WATCH_DIR ?? join(ROOT, 'src');
const LOCK = process.env.NOVO_QA_BROWSER_LOCK ?? join(ROOT, 'data', 'browser-session.lock');
const CHILD = process.env.NOVO_QA_CHILD ? [process.env.NOVO_QA_CHILD] : ['--import', 'tsx', join(ROOT, 'src', 'mcp', 'main.ts')];
const RELOAD_ID_PREFIX = 'novo-qa-reload-';

type Message = { id?: string | number; method?: string; [k: string]: unknown };

let child: ChildProcessByStdio<Writable, Readable, null>;
let generation = 0;
let initializeMsg: Message | undefined;
let initializedMsg: Message | undefined;
/** Chamada do cliente sem resposta ainda → quando foi enviada. */
const inflight = new Map<string | number, number>();
const STALE_MS = 120_000;
let pending = false;
let restarting = false;
let closing = false;
/** Falso enquanto o filho novo não terminou o handshake: mensagens do cliente vão para a fila. */
let ready = true;
const queue: string[] = [];

function flushQueue(): void {
  ready = true;
  for (const line of queue.splice(0)) child.stdin.write(`${line}\n`);
}

/** Chamadas que o filho morto não vai responder: o cliente recebe erro em vez de ficar esperando. */
function failInflight(reason: string): void {
  for (const id of inflight.keys()) toClientRaw({ jsonrpc: '2.0', id, error: { code: -32000, message: reason } });
  inflight.clear();
}

const log = (msg: string) => process.stderr.write(`[novo-qa launcher] ${msg}\n`);
const toClient = (m: Message) => process.stdout.write(`${JSON.stringify(m)}\n`);
const toClientRaw = (m: object) => process.stdout.write(`${JSON.stringify(m)}\n`);

function start(replay: boolean): void {
  generation++;
  child = spawn(process.execPath, CHILD, { cwd: ROOT, env: process.env, stdio: ['pipe', 'pipe', 'inherit'] });
  const current = child;
  createInterface({ input: current.stdout }).on('line', (line) => {
    let msg: Message;
    try {
      msg = JSON.parse(line) as Message;
    } catch {
      return; // stdout é só JSON-RPC; qualquer outra coisa é descartada
    }
    if (typeof msg.id === 'string' && msg.id.startsWith(RELOAD_ID_PREFIX)) {
      // Resposta ao initialize repetido: o cliente já fez o handshake; só avisa que as ferramentas mudaram.
      if (initializedMsg) current.stdin.write(`${JSON.stringify(initializedMsg)}\n`);
      flushQueue();
      toClient({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
      log(`código recarregado (geração ${generation})`);
      return;
    }
    if (msg.id !== undefined && !msg.method) inflight.delete(msg.id);
    toClient(msg);
    tryRestart();
  });
  current.on('exit', (code) => {
    // Reinício planejado (tryRestart) cuida de subir o próximo; aqui só queda inesperada.
    if (closing || restarting || current !== child) return;
    // Saída inesperada: sobe de novo e refaz o handshake, se o cliente já tinha feito.
    log(`servidor saiu (código ${code}); reiniciando`);
    failInflight('servidor novo-qa reiniciou; repita a chamada');
    start(initializeMsg !== undefined);
  });
  if (replay && initializeMsg) {
    ready = false;
    current.stdin.write(`${JSON.stringify({ ...initializeMsg, id: `${RELOAD_ID_PREFIX}${generation}` })}\n`);
  } else {
    flushQueue();
  }
}

/** Navegador aberto = trava com o PID do servidor; trava de processo que já morreu não conta. */
function browserOpen(): boolean {
  if (!existsSync(LOCK)) return false;
  const pid = Number(readFileSync(LOCK, 'utf8').trim());
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function safeToRestart(): boolean {
  // Uma chamada perdida não pode travar a recarga para sempre.
  const now = Date.now();
  for (const [id, sentAt] of inflight) if (now - sentAt > STALE_MS) inflight.delete(id);
  return inflight.size === 0 && !browserOpen();
}

function tryRestart(): void {
  if (!pending || restarting || !safeToRestart()) return;
  pending = false;
  restarting = true;
  ready = false; // daqui até o handshake do filho novo, o que o cliente mandar fica na fila
  const old = child;
  const timer = setTimeout(() => old.kill(), 5000);
  old.once('exit', () => {
    clearTimeout(timer);
    restarting = false;
    start(true);
  });
  // Fechar o stdin dispara o encerramento limpo do servidor (fecha navegador e banco).
  old.stdin.end();
}

let debounce: NodeJS.Timeout | undefined;
watch(WATCH_DIR, { recursive: true }, (_event, file) => {
  if (!file || !/\.(ts|mjs|cjs|js|json|ya?ml)$/.test(file.toString())) return;
  clearTimeout(debounce);
  debounce = setTimeout(() => {
    pending = true;
    log(`mudança em ${file}; recarrego quando estiver ocioso e sem navegador aberto`);
    tryRestart();
  }, 400);
});
// Navegador aberto adia o reinício: confere de tempos em tempos.
setInterval(tryRestart, 3000).unref();

createInterface({ input: process.stdin }).on('line', (line) => {
  let msg: Message;
  try {
    msg = JSON.parse(line) as Message;
  } catch {
    return;
  }
  if (msg.method === 'initialize') initializeMsg = msg;
  if (msg.method === 'notifications/initialized') initializedMsg = msg;
  if (msg.id !== undefined && msg.method) inflight.set(msg.id, Date.now());
  // Durante a troca de processo, a mensagem espera o filho novo (antes ia para o velho e se perdia).
  if (ready) child.stdin.write(`${line}\n`);
  else queue.push(line);
}).on('close', () => {
  closing = true;
  child.stdin.end();
  setTimeout(() => process.exit(0), 5000).unref();
  child.once('exit', () => process.exit(0));
});

start(false);
