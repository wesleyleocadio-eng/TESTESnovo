import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { afterEach, describe, expect, it } from 'vitest';

const REPO = join(import.meta.dirname, '..');
type Msg = { id?: number | string; method?: string; result?: { pid: number } };

let proc: ChildProcessWithoutNullStreams | undefined;
let dir: string;

afterEach(() => {
  proc?.stdin.end();
  proc?.kill();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function launch() {
  dir = mkdtempSync(join(tmpdir(), 'novo-qa-launcher-'));
  const lock = join(dir, 'browser-session.lock');
  proc = spawn(process.execPath, ['--import', 'tsx', join(REPO, 'src', 'mcp', 'launcher.ts')], {
    cwd: REPO,
    env: { ...process.env, NOVO_QA_CHILD: join(REPO, 'test', 'fixture-app', 'fake-mcp-child.cjs'), NOVO_QA_WATCH_DIR: dir, NOVO_QA_BROWSER_LOCK: lock },
  });
  const received: Msg[] = [];
  createInterface({ input: proc.stdout }).on('line', (l) => received.push(JSON.parse(l) as Msg));
  const send = (m: object) => proc!.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
  const waitFor = async (pred: (m: Msg) => boolean, ms = 10_000): Promise<Msg> => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const hit = received.find(pred);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`timeout esperando mensagem; recebidas: ${JSON.stringify(received)}`);
  };
  const reloads = () => received.filter((m) => m.method === 'notifications/tools/list_changed').length;
  const touch = (name = 'x.ts') => writeFileSync(join(dir, name), String(Date.now()));
  return { send, waitFor, reloads, touch, lock };
}

describe('launcher (recarga sem reconectar)', () => {
  it('reinicia o servidor quando o código muda, refaz o handshake e avisa o cliente', async () => {
    const l = launch();
    l.send({ id: 1, method: 'initialize', params: {} });
    const first = await l.waitFor((m) => m.id === 1);
    l.send({ method: 'notifications/initialized' });

    l.touch();
    await l.waitFor((m) => m.method === 'notifications/tools/list_changed');
    l.send({ id: 2, method: 'tools/list' });
    const after = await l.waitFor((m) => m.id === 2);
    expect(after.result!.pid).not.toBe(first.result!.pid);
    // Um único reinício (sem servidor órfão) e a resposta ao initialize repetido não vaza para o cliente.
    await new Promise((r) => setTimeout(r, 1500));
    expect(l.reloads()).toBe(1);
  }, 30_000);

  it('não reinicia com navegador aberto; reinicia quando ele fecha', async () => {
    const l = launch();
    l.send({ id: 1, method: 'initialize', params: {} });
    await l.waitFor((m) => m.id === 1);
    writeFileSync(l.lock, String(process.pid)); // processo vivo = navegador aberto
    l.touch();
    await new Promise((r) => setTimeout(r, 4000));
    expect(l.reloads()).toBe(0);
    rmSync(l.lock);
    await l.waitFor((m) => m.method === 'notifications/tools/list_changed', 8000);
    expect(l.reloads()).toBe(1);
  }, 30_000);

  it('trava de processo morto não impede a recarga', async () => {
    const l = launch();
    l.send({ id: 1, method: 'initialize', params: {} });
    await l.waitFor((m) => m.id === 1);
    writeFileSync(l.lock, '999999'); // PID inexistente
    l.touch();
    await l.waitFor((m) => m.method === 'notifications/tools/list_changed', 8000);
  }, 30_000);

  it('mensagem enviada durante a troca de processo é entregue ao servidor novo (não se perde)', async () => {
    const l = launch();
    l.send({ id: 1, method: 'initialize', params: {} });
    const first = await l.waitFor((m) => m.id === 1);
    l.send({ method: 'notifications/initialized' });
    l.touch();
    // Rajada de chamadas cobrindo a janela da troca.
    for (let i = 0; i < 25; i++) {
      l.send({ id: 100 + i, method: 'ping' });
      await new Promise((r) => setTimeout(r, 40));
    }
    for (let i = 0; i < 25; i++) await l.waitFor((m) => m.id === 100 + i, 8000);
    await l.waitFor((m) => m.method === 'notifications/tools/list_changed');
    // E a recarga seguinte continua possível (nenhuma chamada ficou "em andamento" para sempre).
    l.send({ id: 200, method: 'tools/list' });
    const second = await l.waitFor((m) => m.id === 200);
    l.touch('y.ts');
    await l.waitFor(() => l.reloads() === 2, 10_000);
    l.send({ id: 201, method: 'tools/list' });
    const third = await l.waitFor((m) => m.id === 201);
    expect(new Set([first.result!.pid, second.result!.pid, third.result!.pid]).size).toBe(3);
  }, 40_000);

  it('espera a chamada em andamento terminar (no servidor antigo) antes de reiniciar', async () => {
    const l = launch();
    l.send({ id: 1, method: 'initialize', params: {} });
    const first = await l.waitFor((m) => m.id === 1);
    l.send({ id: 2, method: 'slow' });
    l.touch();
    const slow = await l.waitFor((m) => m.id === 2);
    expect(slow.result!.pid).toBe(first.result!.pid);
    await l.waitFor((m) => m.method === 'notifications/tools/list_changed');
  }, 30_000);
});
