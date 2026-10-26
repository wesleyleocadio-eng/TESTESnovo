import type { Page, Request } from 'playwright';

const TRACKED = new Set(['document', 'xhr', 'fetch']);
const MAX_ENTRIES = 500;
const MAX_BODY = 20_000;

export interface NetEntry {
  id: number;
  method: string;
  url: string;
  path: string;
  resourceType: string;
  startedAt: number;
  status?: number;
  failure?: string;
  durationMs?: number;
  requestHeaders?: Record<string, string>;
  requestBody?: string;
  responseHeaders?: Record<string, string>;
  responseBody?: string;
}

/** Captura requests de documento/XHR/fetch. Assets (img, css, js, fontes) são ignorados. */
export class NetworkLog {
  readonly entries: NetEntry[] = [];
  private inflight = 0;
  private lastActivity = Date.now();
  private nextId = 1;
  private readonly byRequest = new WeakMap<Request, NetEntry>();
  /** Último Authorization que a própria aplicação enviou, por origem (só em memória; nunca devolvido). */
  private readonly authByOrigin = new Map<string, string>();

  authorizationFor(origin: string): string | undefined {
    return this.authByOrigin.get(origin);
  }

  /** onHttpError: chamado para XHR/fetch com status ≥ 400, já com o corpo da resposta (se legível). */
  attach(page: Page, onHttpError?: (entry: NetEntry) => void): void {
    page.on('request', (req) => {
      if (!TRACKED.has(req.resourceType())) return;
      const url = new URL(req.url());
      const auth = req.headers().authorization;
      if (auth) this.authByOrigin.set(url.origin, auth);
      const entry: NetEntry = {
        id: this.nextId++,
        method: req.method(),
        url: req.url(),
        path: url.pathname + url.search,
        resourceType: req.resourceType(),
        startedAt: Date.now(),
        requestHeaders: req.headers(),
        requestBody: req.postData()?.slice(0, MAX_BODY) ?? undefined,
      };
      this.byRequest.set(req, entry);
      this.entries.push(entry);
      if (this.entries.length > MAX_ENTRIES) this.entries.shift();
      this.inflight++;
      this.lastActivity = Date.now();
    });
    // Status no recebimento dos headers: se a página navegar logo depois (ex.: login),
    // o corpo é cancelado e 'requestfinished' nunca chega — a request não pode ficar pendente.
    page.on('response', async (res) => {
      const entry = this.byRequest.get(res.request());
      if (!entry) return;
      entry.status = res.status();
      entry.responseHeaders = res.headers();
      this.finish(entry);
      const type = res.headers()['content-type'] ?? '';
      if (entry.resourceType !== 'document' && /json|text|problem/.test(type)) {
        const body = await Promise.race([res.text().catch(() => undefined), new Promise<undefined>((r) => setTimeout(r, 2000))]);
        if (body !== undefined) entry.responseBody = body.slice(0, MAX_BODY);
      }
      if (entry.status >= 400 && entry.resourceType !== 'document') onHttpError?.(entry);
    });
    page.on('requestfailed', (req) => {
      const entry = this.byRequest.get(req);
      if (!entry || entry.status !== undefined) return;
      entry.failure = req.failure()?.errorText ?? 'failed';
      this.finish(entry);
    });
  }

  private finish(entry: NetEntry): void {
    if (entry.durationMs !== undefined) return;
    entry.durationMs = Date.now() - entry.startedAt;
    this.inflight = Math.max(0, this.inflight - 1);
    this.lastActivity = Date.now();
  }

  since(ts: number): NetEntry[] {
    return this.entries.filter((e) => e.startedAt >= ts);
  }

  /** Espera a rede ficar ociosa por `idleMs` (máximo `maxMs`). */
  async waitQuiet(idleMs = 400, maxMs = 5000): Promise<void> {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      if (this.inflight === 0 && Date.now() - this.lastActivity >= idleMs) return;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

export function summarize(e: NetEntry): string {
  const result = e.failure ? `FALHOU (${e.failure})` : e.status === undefined ? 'pendente' : String(e.status);
  return `#${e.id} ${e.method} ${e.path} → ${result}${e.durationMs !== undefined ? ` (${e.durationMs}ms)` : ''}`;
}

export interface ConsoleEntry {
  type: string;
  text: string;
  ts: number;
}

export class ConsoleLog {
  readonly entries: ConsoleEntry[] = [];

  attach(page: Page, onError: (entry: ConsoleEntry) => void): void {
    const push = (entry: ConsoleEntry) => {
      this.entries.push(entry);
      if (this.entries.length > MAX_ENTRIES) this.entries.shift();
      if (entry.type === 'error' || entry.type === 'pageerror') onError(entry);
    };
    page.on('console', (msg) => {
      if (msg.type() === 'error' || msg.type() === 'warning') push({ type: msg.type(), text: msg.text(), ts: Date.now() });
    });
    page.on('pageerror', (err) => push({ type: 'pageerror', text: err.message, ts: Date.now() }));
  }

  since(ts: number, errorsOnly = false): ConsoleEntry[] {
    return this.entries.filter((e) => e.ts >= ts && (!errorsOnly || e.type !== 'warning'));
  }
}
