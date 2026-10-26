import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright';
import { resolveValue } from '../config/load.ts';
import type { Config, Environment } from '../config/schema.ts';
import { displayPath, evidencePath, writeEvidence } from '../evidence/files.ts';
import { classifyAction } from '../guard/classify.ts';
import { decide, GuardError } from '../guard/guard.ts';
import { extractId, type CleanupSpec } from '../state/cleanup.ts';
import type { Redactor } from '../security/redact.ts';
import type { SecretStore } from '../security/secrets.ts';
import { sanitizeTraceZip } from '../security/trace.ts';
import type { FinalStatus, VerificationKind } from '../state/rules.ts';
import type { RunRow, StateStore } from '../state/store.ts';
import { ConsoleLog, NetworkLog, summarize, type NetEntry } from './observers.ts';
import { ariaSnapshot, diffSnapshots } from './snapshot.ts';
import { describeTarget, resolveOne, toLocator, type Target } from './target.ts';
import { resolveValueRef } from './values.ts';

export class BrowserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrowserError';
  }
}

export interface BrowserDeps {
  rootDir: string;
  config: Config;
  store: StateStore;
  secrets: SecretStore;
  redactor: Redactor;
  /** Canal do navegador (ex.: "chrome"); padrão: Chromium do Playwright. */
  channel?: string;
}

export type ActAction = 'click' | 'fill' | 'select' | 'check' | 'uncheck' | 'press' | 'hover' | 'upload';

export interface ActInput {
  action: ActAction;
  target: Target;
  value?: string;
  valueRef?: string;
  valueType?: string;
  key?: string;
  files?: string[];
  dialog?: 'accept' | 'dismiss';
}

export interface Simulation {
  urlContains: string;
  method?: string;
  /** Responde com este status (sem chegar ao servidor). */
  status?: number;
  body?: string;
  /** Atrasa a request (loading); combinável com status/abort. */
  delayMs?: number;
  /** Simula falha de rede. */
  abort?: boolean;
  /** Quantas vezes aplicar (-1 = até o fim do cenário). */
  remaining: number;
  hits: number;
}

export const VIEWPORTS = {
  mobile: { width: 390, height: 844 },
  tablet: { width: 820, height: 1180 },
  desktop: { width: 1440, height: 900 },
} as const;

export type UiCondition = 'visible' | 'hidden' | 'containsText' | 'hasValue' | 'enabled' | 'disabled' | 'checked' | 'count' | 'attribute';

export interface VerifyInput {
  kind: VerificationKind;
  description: string;
  target?: Target;
  condition?: UiCondition;
  text?: string;
  /** Para condition "attribute": nome do atributo (ex.: href). */
  attribute?: string;
  count?: number;
  urlPattern?: string;
  method?: string;
  urlContains?: string;
  status?: string;
  path?: string;
  bodyContains?: string;
  /** network: trecho que o corpo ENVIADO pela aplicação deve conter. */
  requestBodyContains?: string;
  timeoutMs?: number;
}

interface Session {
  runId: string;
  issueKey: string;
  envId: string;
  env: Environment;
  baseUrl: string;
  role?: string;
  browser: Browser;
  context: BrowserContext;
  page: Page;
  net: NetworkLog;
  console: ConsoleLog;
  dialogs: { message: string; type: string; handled: 'accept' | 'dismiss'; blocked: boolean; ts: number }[];
  nextDialog: 'accept' | 'dismiss';
  /** Verdadeiro só durante uma ação RED aprovada (act_approved). */
  redApproved: boolean;
  /** Requests destrutivas barradas na rede (rede de segurança além da classificação). */
  blocked: { method: string; path: string; ts: number }[];
  /** Respostas simuladas ativas (só no navegador do teste; limpas ao fim de cada cenário). */
  simulations: Simulation[];
  /** Início da janela do cenário atual (ou da sessão, se aberta no meio de um cenário). */
  windowStart: number;
  /** Cenário dono do chunk de trace aberto, se houver. */
  traceCode: string | null;
  /** Respostas de API com erro já salvas como evidência, por cenário (limite). */
  httpErrors: Map<string, number>;
  /** Gravação da sessão: início e capítulos (cenário → segundos desde o início do vídeo). */
  video?: { startedAt: number; dir: string; chapters: { code: string; atSec: number }[] };
}

const POLL_MS = 200;
const MAX_HTTP_ERRORS_PER_SCENARIO = 15;

export class BrowserService {
  private session?: Session;

  constructor(private readonly deps: BrowserDeps) {}

  private get s(): Session {
    if (!this.session) throw new BrowserError('nenhum navegador aberto — use browser_open');
    return this.session;
  }

  private authPath(envId: string, role: string): string {
    return join(this.deps.rootDir, '.auth', `${envId}-${role}.json`);
  }

  private currentScenario(): string | null {
    return this.deps.store.getRun(this.s.runId).current_scenario;
  }

  private requireScenario(): string {
    const code = this.currentScenario();
    if (!code) throw new BrowserError('nenhum cenário em andamento — use scenario_start antes de verificar');
    return code;
  }

  private scenarioId(code: string | null): number | null {
    return code ? this.deps.store.getScenario(this.s.runId, code).id : null;
  }

  // ── Sessão ──────────────────────────────────────────────────────────

  async open(input: { runId: string; role?: string; headed?: boolean; fresh?: boolean }) {
    const run: RunRow = this.deps.store.getRun(input.runId);
    if (run.status !== 'EXECUTING') throw new BrowserError(`run está ${run.status}; o navegador só abre com plano aprovado`);
    const env = this.deps.config.environments[run.env]!;
    const baseUrl = resolveValue(env.baseUrl);
    if (!baseUrl) throw new BrowserError(`baseUrl do ambiente ${run.env} não definida — preencha o .env`);
    if (input.role && !env.roles[input.role]) {
      throw new BrowserError(`papel "${input.role}" não existe em ${run.env} (papéis: ${Object.keys(env.roles).join(', ')})`);
    }

    await this.close();
    const browser = await chromium.launch({ headless: !input.headed, ...(this.deps.channel ? { channel: this.deps.channel } : {}) });
    const statePath = input.role ? this.authPath(run.env, input.role) : undefined;
    // fresh: ignora a sessão salva (login do zero) mas mantém o papel, para poder salvar de novo.
    const authReused = !input.fresh && statePath !== undefined && existsSync(statePath);
    const recordVideo = this.deps.config.policy.evidence.video === 'always';
    const videoDir = join(this.deps.rootDir, 'runs', run.issue_key, run.id, 'evidence', `.video-${Date.now()}`);
    const context = await browser.newContext({
      baseURL: baseUrl,
      viewport: { width: 1440, height: 900 },
      ...(authReused ? { storageState: statePath } : {}),
      ...(recordVideo ? { recordVideo: { dir: videoDir, size: { width: 1440, height: 900 } } } : {}),
    });
    const page = await context.newPage();

    const session: Session = {
      runId: run.id, issueKey: run.issue_key, envId: run.env, env, baseUrl, role: input.role,
      browser, context, page, net: new NetworkLog(), console: new ConsoleLog(),
      dialogs: [], nextDialog: 'dismiss', windowStart: Date.now(), traceCode: null, redApproved: false, blocked: [], httpErrors: new Map(), simulations: [],
      ...(recordVideo ? { video: { startedAt: Date.now(), dir: videoDir, chapters: [] } } : {}),
    };
    session.net.attach(page, (entry) => {
      if (this.session === session) this.saveHttpError(session, entry);
    });
    session.console.attach(page, (entry) => {
      const code = this.session === session ? this.currentScenario() : null;
      this.deps.store.logEvent(session.runId, this.scenarioId(code), 'console.error', { text: this.deps.redactor.text(entry.text.slice(0, 300)) });
    });
    page.on('dialog', async (dialog) => {
      let handled = session.nextDialog;
      // Aceitar uma confirmação destrutiva é uma ação RED: só dentro de act_approved.
      const blocked = handled === 'accept' && !session.redApproved &&
        classifyAction('click', dialog.message(), this.deps.config.policy).level === 'RED';
      if (blocked) handled = 'dismiss';
      session.dialogs.push({ message: dialog.message(), type: dialog.type(), handled, blocked, ts: Date.now() });
      session.nextDialog = 'dismiss';
      await (handled === 'accept' ? dialog.accept() : dialog.dismiss()).catch(() => undefined);
    });
    // Rede de segurança: DELETE vindo da página só passa durante ação RED aprovada.
    // (A limpeza usa context.request, que não passa por aqui.)
    await context.route('**/*', async (route) => {
      const req = route.request();
      // Simulação (CA de estados de erro/carregamento): responde no navegador, sem chegar ao servidor.
      const sim = session.simulations.find((s) => req.url().includes(s.urlContains) && (!s.method || s.method === req.method()) && s.remaining !== 0);
      if (sim) {
        if (sim.remaining > 0) sim.remaining--;
        sim.hits++;
        if (sim.delayMs) await new Promise((r) => setTimeout(r, sim.delayMs));
        if (sim.abort) return route.abort('failed');
        if (sim.status !== undefined) {
          return route.fulfill({ status: sim.status, contentType: 'application/json', body: sim.body ?? JSON.stringify({ error: `simulado pelo NOVO QA (${sim.status})` }) });
        }
        // Só atraso: segue para o servidor (ainda sob o guard de DELETE abaixo).
      }
      if (req.method() !== 'DELETE' || session.redApproved) return route.continue();
      const url = new URL(req.url());
      session.blocked.push({ method: req.method(), path: url.pathname + url.search, ts: Date.now() });
      const code = this.session === session ? this.currentScenario() : null;
      this.deps.store.logEvent(session.runId, this.scenarioId(code), 'guard.network_block', { method: req.method(), path: url.pathname });
      return route.abort('blockedbyclient');
    });
    this.session = session;
    this.writeLock();
    this.deps.store.logEvent(run.id, null, 'browser.open', { role: input.role ?? null });

    // Sessão aberta no meio de um cenário (ex.: retomada): a janela de trace começa agora.
    const current = this.currentScenario();
    if (current) await this.startTraceChunk(current);

    const nav = await this.navigate({ url: '/' }, { record: false });
    return {
      ...nav,
      role: input.role ?? null,
      authReused,
      hint: input.role && !authReused
        ? `faça login com act usando valueRef role:${input.role}.username / role:${input.role}.password e depois browser_save_auth`
        : undefined,
    };
  }

  status(): { open: false } | { open: true; runId: string; role: string | null; url: string } {
    const s = this.session;
    return s ? { open: true, runId: s.runId, role: s.role ?? null, url: s.page.url() } : { open: false };
  }

  async saveAuth() {
    const { role, envId, context } = this.s;
    if (!role) throw new BrowserError('sessão aberta sem papel; abra com browser_open(role)');
    const path = this.authPath(envId, role);
    mkdirSync(dirname(path), { recursive: true });
    await context.storageState({ path });
    return { saved: `${envId}/${role}` };
  }

  async close() {
    const session = this.session;
    this.session = undefined;
    if (!session) return { closed: false };
    if (session.traceCode) await session.context.tracing.stop().catch(() => undefined);
    const video = session.page.video();
    // Fechar o contexto finaliza o arquivo de vídeo.
    await session.context.close().catch(() => undefined);
    await session.browser.close().catch(() => undefined);
    rmSync(this.lockPath(), { force: true });
    const saved = video && session.video ? this.saveVideo(session, await video.path().catch(() => undefined)) : undefined;
    return { closed: true, ...(saved ? { video: saved } : {}) };
  }

  /**
   * Move o vídeo da sessão para evidence/ e registra: uma evidência da sessão (com os capítulos)
   * e uma por cenário gravado, apontando o segundo em que ele começa.
   */
  private saveVideo(session: Session, tmpPath: string | undefined): string | undefined {
    if (!tmpPath || !existsSync(tmpPath) || !session.video) return undefined;
    const name = `video-${new Date(session.video.startedAt).toISOString().replace(/[:.]/g, '-')}.webm`;
    const finalPath = evidencePath(this.deps.rootDir, session.issueKey, session.runId, name);
    renameSync(tmpPath, finalPath);
    rmSync(session.video.dir, { recursive: true, force: true });
    const rel = displayPath(this.deps.rootDir, finalPath);
    const chapters = session.video.chapters;
    this.deps.store.recordEvidence(session.runId, null, { kind: 'video', path: rel, meta: { chapters } });
    for (const c of chapters) {
      try {
        this.deps.store.recordEvidence(session.runId, c.code, { kind: 'video', path: rel, meta: { atSec: c.atSec } });
      } catch {
        // cenário apagado/replanejado: o capítulo fica só na evidência da sessão
      }
    }
    return rel;
  }

  /**
   * Resposta de API com erro (≥ 400) vira evidência em arquivo, sanitizada: request, status,
   * headers e corpo da resposta (ex.: stack trace de um 500). Antes só existia em memória.
   * Limite por cenário para não inundar a pasta com erros repetidos.
   */
  private saveHttpError(session: Session, entry: NetEntry): void {
    try {
      const code = this.currentScenario();
      const key = code ?? '(run)';
      const n = (session.httpErrors.get(key) ?? 0) + 1;
      session.httpErrors.set(key, n);
      if (n > MAX_HTTP_ERRORS_PER_SCENARIO) return;
      const r = this.deps.redactor;
      const text = [
        `${entry.method} ${entry.url}`,
        `status: ${entry.status}`,
        '',
        '## request headers',
        JSON.stringify(r.value(entry.requestHeaders ?? {}), null, 2),
        ...(entry.requestBody ? ['', '## request body', r.text(entry.requestBody)] : []),
        '',
        '## response headers',
        JSON.stringify(r.value(entry.responseHeaders ?? {}), null, 2),
        '',
        '## response body',
        r.text(entry.responseBody ?? '(corpo não legível ou não capturado)'),
      ].join('\n');
      const path = evidencePath(this.deps.rootDir, session.issueKey, session.runId, `${code ?? 'run'}-http-${entry.status}-${entry.id}.txt`);
      const sha256 = writeEvidence(path, text);
      this.deps.store.recordEvidence(session.runId, code, {
        kind: 'http-error', path: displayPath(this.deps.rootDir, path), sha256, meta: { status: entry.status, method: entry.method, path: entry.path },
      });
    } catch {
      // evidência é complementar: falha ao gravar não pode quebrar a execução
    }
  }

  /**
   * Trava com o PID enquanto há navegador aberto: o supervisor (launcher) não recarrega o
   * servidor nesse estado, para não derrubar um lote no meio.
   */
  lockPath(): string {
    return join(this.deps.rootDir, 'data', 'browser-session.lock');
  }

  private writeLock(): void {
    mkdirSync(join(this.deps.rootDir, 'data'), { recursive: true });
    writeFileSync(this.lockPath(), String(process.pid));
  }

  // ── Ciclo do cenário (chamado pelas ferramentas de estado) ───────────

  private async startTraceChunk(code: string) {
    const session = this.s;
    session.windowStart = Date.now();
    session.video?.chapters.push({ code, atSec: Math.round((Date.now() - session.video.startedAt) / 1000) });
    if (session.traceCode) await session.context.tracing.stop().catch(() => undefined);
    await session.context.tracing.start({ screenshots: true, snapshots: true });
    session.traceCode = code;
  }

  async onScenarioStart(runId: string, code: string) {
    if (this.session?.runId !== runId || this.session.traceCode === code) return;
    await this.startTraceChunk(code);
  }

  /** Trace só é mantido em falha; nos demais casos o chunk é descartado. */
  async onScenarioEnd(runId: string, code: string, status: FinalStatus) {
    const session = this.session;
    if (session?.runId === runId) session.simulations = []; // simulação nunca vaza para o próximo cenário
    if (session?.runId !== runId || session.traceCode !== code) return;
    session.traceCode = null;
    if (status !== 'FAILED') {
      await session.context.tracing.stop().catch(() => undefined);
      return;
    }
    const path = evidencePath(this.deps.rootDir, session.issueKey, runId, `${code}-trace.zip`);
    await session.context.tracing.stop({ path });
    sanitizeTraceZip(path, this.deps.redactor);
    this.deps.store.recordEvidence(runId, code, { kind: 'trace', path: displayPath(this.deps.rootDir, path) });
  }

  // ── Observação ──────────────────────────────────────────────────────

  async navigate(input: { url: string; snapshot?: boolean }, opts: { record?: boolean } = {}) {
    const { page, net } = this.s;
    const started = Date.now();
    const response = await page.goto(input.url, { waitUntil: 'domcontentloaded' });
    await net.waitQuiet();
    if (opts.record !== false) {
      this.deps.store.recordAction(this.s.runId, this.currentScenario(), {
        action: 'navigate', target: { url: new URL(page.url()).pathname }, guardLevel: 'GREEN', ok: true,
        url: page.url(), durationMs: Date.now() - started,
      });
    }
    const result: Record<string, unknown> = { url: page.url(), status: response?.status() ?? null, title: await page.title() };
    if (input.snapshot !== false) result.snapshot = (await ariaSnapshot(page, undefined, 4000)).text;
    return result;
  }

  async snapshot(input: { scope?: Target; maxChars?: number }) {
    const { page } = this.s;
    const scope = input.scope ? await resolveOne(page, input.scope) : undefined;
    const snap = await ariaSnapshot(page, scope, input.maxChars ?? 8000);
    return { url: page.url(), ...snap };
  }

  network(input: { urlContains?: string; method?: string; id?: number; limit?: number }) {
    const { net } = this.s;
    const code = this.currentScenario();
    this.deps.store.logEvent(this.s.runId, this.scenarioId(code), 'inspect.network', null);
    if (input.id !== undefined) {
      const e = net.entries.find((x) => x.id === input.id);
      if (!e) throw new BrowserError(`request #${input.id} não está no buffer`);
      return this.deps.redactor.value({
        summary: summarize(e), url: e.url, requestHeaders: e.requestHeaders, requestBody: e.requestBody?.slice(0, 4000),
        responseHeaders: e.responseHeaders, responseBody: e.responseBody?.slice(0, 4000),
      });
    }
    const matches = net
      .since(this.s.windowStart)
      .filter((e) => (!input.urlContains || e.url.includes(input.urlContains)) && (!input.method || e.method === input.method.toUpperCase()));
    return { requests: matches.slice(-(input.limit ?? 20)).map(summarize), total: matches.length };
  }

  consoleMessages(input: { errorsOnly?: boolean; limit?: number }) {
    const code = this.currentScenario();
    this.deps.store.logEvent(this.s.runId, this.scenarioId(code), 'inspect.console', null);
    const entries = this.s.console.since(this.s.windowStart, input.errorsOnly ?? false);
    return { messages: entries.slice(-(input.limit ?? 30)).map((e) => `[${e.type}] ${e.text.slice(0, 500)}`), total: entries.length };
  }

  async screenshot(input: { target?: Target; fullPage?: boolean; label?: string }) {
    const { page, runId, issueKey } = this.s;
    const code = this.currentScenario();
    const mask = this.deps.config.policy.redaction.maskSelectors.map((sel) => page.locator(sel));
    const name = `${code ?? 'run'}-${Date.now()}-${(input.label ?? 'screenshot').replace(/[^\w-]+/g, '_')}.png`;
    const path = evidencePath(this.deps.rootDir, issueKey, runId, name);
    const shot = input.target
      ? await (await resolveOne(page, input.target)).screenshot({ mask })
      : await page.screenshot({ fullPage: input.fullPage ?? false, mask });
    const sha256 = writeEvidence(path, shot);
    const rel = displayPath(this.deps.rootDir, path);
    const evidenceId = this.deps.store.recordEvidence(runId, code, { kind: 'screenshot', path: rel, sha256, meta: { url: page.url() } });
    return { evidenceId, path: rel, png: shot };
  }

  // ── Condições de teste (só no navegador do teste) ────────────────────

  /** Tamanho da janela para validar responsivo (breakpoints CSS). Não emula toque/user-agent. */
  async viewport(input: { preset?: keyof typeof VIEWPORTS; width?: number; height?: number }) {
    const { page, runId } = this.s;
    const size = input.preset ? VIEWPORTS[input.preset] : input.width && input.height ? { width: input.width, height: input.height } : undefined;
    if (!size) throw new BrowserError('informe preset (mobile|tablet|desktop) ou width e height');
    await page.setViewportSize(size);
    await this.s.net.waitQuiet(300, 2000);
    this.deps.store.recordAction(runId, this.currentScenario(), { action: 'viewport', target: { viewport: `${size.width}x${size.height}` }, guardLevel: 'GREEN', ok: true, url: page.url() });
    return { viewport: size, ...(input.preset ? { preset: input.preset } : {}), note: 'redimensiona a janela; não emula toque nem user-agent mobile' };
  }

  /**
   * Simula resposta de API no navegador do teste (erro, vazio, lentidão, queda de rede) para
   * validar estados de erro/carregamento. Não chega ao servidor; é limpa ao fim do cenário.
   */
  simulate(input: { urlContains: string; method?: string; status?: number; body?: string; delayMs?: number; abort?: boolean; times?: number }) {
    const session = this.s;
    if (input.status === undefined && !input.abort && !input.delayMs) throw new BrowserError('informe status, abort ou delayMs');
    const code = this.currentScenario();
    if (!code) throw new BrowserError('simulação só dentro de um cenário (scenario_start antes)');
    const sim: Simulation = {
      urlContains: input.urlContains, method: input.method?.toUpperCase(), status: input.status, body: input.body,
      delayMs: input.delayMs, abort: input.abort, remaining: input.times ?? -1, hits: 0,
    };
    session.simulations.push(sim);
    this.deps.store.logEvent(session.runId, this.scenarioId(code), 'network.simulate', { ...sim, body: sim.body?.slice(0, 200) });
    return { active: session.simulations.map(describeSimulation) };
  }

  clearSimulations() {
    const session = this.s;
    const used = session.simulations.map(describeSimulation);
    session.simulations = [];
    return { cleared: used };
  }

  // ── Ação ────────────────────────────────────────────────────────────

  /** Texto que descreve o efeito do alvo: nome, label, testId, texto, aria-label, title — nunca o seletor css. */
  private async semanticText(locator: Locator, t: Target): Promise<string> {
    const element = await locator
      .evaluate((el) => [el.textContent, el.getAttribute('aria-label'), el.getAttribute('title'), (el as HTMLInputElement).value]
        .filter((x) => x && typeof x === 'string').join(' '))
      .catch(() => '');
    return [t.name, t.label, t.placeholder, t.text, t.testId?.replace(/[-_]/g, ' '), element]
      .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim().slice(0, 200);
  }

  async act(input: ActInput, approval?: { justification: string }) {
    const session = this.s;
    const { page, net } = session;
    const code = this.currentScenario();
    const started = Date.now();
    const urlBefore = page.url();

    const locator = await resolveOne(page, input.target);
    const { level, reason } = classifyAction(input.action, await this.semanticText(locator, input.target), this.deps.config.policy);
    const decision = decide(level, session.env, this.deps.config.policy, approval !== undefined);
    if (!decision.allowed) {
      this.deps.store.recordAction(session.runId, code, {
        action: input.action, target: input.target, guardLevel: level, ok: false,
        error: `BLOQUEADO: ${decision.reason}`, url: urlBefore,
      });
      this.deps.store.logEvent(session.runId, this.scenarioId(code), 'guard.block', { level, reason, needsApproval: decision.needsApproval });
      throw new GuardError(`${input.action} em ${describeTarget(input.target)} bloqueado (${level}: ${reason}) — ${decision.reason}`);
    }
    if (approval) {
      this.deps.store.recordApproval(session.runId, {
        action: input.action, target: describeTarget(input.target), level, justification: approval.justification,
      });
    }

    const resolved = input.valueRef ? resolveValueRef(input.valueRef, session.env, this.deps.secrets) : undefined;
    const value = resolved?.value ?? input.value;
    const valueRecord =
      input.valueRef ??
      (input.action === 'press' && input.key ? `key:${input.key}`
        : input.valueType ? `type:${input.valueType}`
        : value !== undefined ? 'type:literal'
        : undefined);

    const before = (await ariaSnapshot(page, undefined, 50_000)).text;
    session.nextDialog = input.dialog ?? 'dismiss';
    const dialogsBefore = session.dialogs.length;
    const blockedBefore = session.blocked.length;

    try {
      session.redApproved = approval !== undefined;
      await this.perform(locator, input, value);
      await page.waitForLoadState('domcontentloaded').catch(() => undefined);
      await net.waitQuiet();
    } catch (err) {
      this.deps.store.recordAction(session.runId, code, {
        action: input.action, target: input.target, valueRef: valueRecord, guardLevel: level, ok: false,
        error: this.deps.redactor.text((err as Error).message.split('\n')[0]!.slice(0, 300)), url: urlBefore,
        durationMs: Date.now() - started,
      });
      throw new BrowserError(`${input.action} falhou em ${describeTarget(input.target)}: ${(err as Error).message.split('\n')[0]}`);
    } finally {
      session.nextDialog = 'dismiss';
      session.redApproved = false;
    }

    this.deps.store.recordAction(session.runId, code, {
      action: input.action, target: input.target, valueRef: valueRecord, guardLevel: level, ok: true,
      // Valor de valueRef é segredo/credencial: nunca vira amostra.
      ...(input.valueRef === undefined && input.value !== undefined ? { valueSample: input.value } : {}),
      url: urlBefore, durationMs: Date.now() - started,
    });

    // Criação detectada: POST 2xx disparado por ação que altera dados vira candidato a limpeza.
    const requests = net.since(started);
    const createdData = level === 'GREEN' ? [] : requests
      .filter((e) => e.method === 'POST' && e.status !== undefined && e.status >= 200 && e.status < 300)
      .map((e) => {
        const extId = extractId(e.responseBody);
        const id = this.deps.store.addCreatedCandidate(session.runId, code, e.path, extId);
        return { id, resource: e.path, extId: extId ?? null };
      });

    const after = (await ariaSnapshot(page, undefined, 50_000)).text;
    const diff = diffSnapshots(before, after);
    const blocked = session.blocked.slice(blockedBefore);
    return {
      ok: true,
      level,
      levelReason: reason,
      url: page.url() !== urlBefore ? page.url() : undefined,
      dialogs: session.dialogs.slice(dialogsBefore).map((d) =>
        `${d.type} "${d.message}" → ${d.handled}${d.blocked ? ' (BLOQUEADO: confirmação destrutiva exige act_approved)' : ''}`),
      requests: requests.map(summarize),
      blockedRequests: blocked.length ? blocked.map((b) => `${b.method} ${b.path} (bloqueado pelo guard)`) : undefined,
      createdData: createdData.length ? createdData : undefined,
      cleanupHint: createdData.length ? 'registre como desfazer cada item com data_register (id) antes de concluir o run' : undefined,
      consoleErrors: session.console.since(started, true).map((e) => e.text.slice(0, 200)),
      changes: diff,
    };
  }

  private async perform(locator: Locator, input: ActInput, value: string | undefined) {
    const need = () => {
      if (value === undefined) throw new BrowserError(`${input.action} exige value ou valueRef`);
      return value;
    };
    switch (input.action) {
      case 'click': return locator.click();
      case 'fill': return locator.fill(need());
      case 'select': return void (await locator.selectOption(need()));
      case 'check': return locator.check();
      case 'uncheck': return locator.uncheck();
      case 'hover': return locator.hover();
      case 'press':
        if (!input.key) throw new BrowserError('press exige key (ex.: Enter)');
        return locator.press(input.key);
      case 'upload': {
        const files = (input.files ?? []).map((f) => join(this.deps.rootDir, f));
        const missing = files.filter((f) => !existsSync(f));
        if (files.length === 0 || missing.length > 0) throw new BrowserError('upload exige files existentes (caminhos relativos ao projeto)');
        return locator.setInputFiles(files);
      }
    }
  }

  // ── Limpeza ─────────────────────────────────────────────────────────

  /**
   * Executa a limpeza registrada (api) e prova a remoção com o GET de `verify` (api e manual).
   * Usa a sessão autenticada; só desfaz dados que o próprio run registrou.
   */
  async cleanup(runId: string) {
    // Nada registrado para limpar: responde sem exigir navegador nem permissão de escrita.
    const todo = this.deps.store.listCreatedData(runId).filter((d) => d.cleanup_status === 'PENDING' || d.cleanup_status === 'FAILED');
    if (todo.length === 0) {
      const open = this.deps.store.listCreatedData(runId).filter((d) => d.cleanup_status === 'UNREGISTERED').map((d) => d.id);
      return { results: [], nothingToClean: open.length === 0, unregistered: open.length ? open : undefined };
    }
    const session = this.s;
    if (session.runId !== runId) throw new BrowserError(`navegador aberto é do run ${session.runId}`);
    const decision = decide('YELLOW', session.env, this.deps.config.policy, false);
    if (!decision.allowed) throw new GuardError(`limpeza bloqueada: ${decision.reason}`);

    const results: { id: number; resource: string; status: 'VERIFIED' | 'FAILED'; detail: string }[] = [];
    for (const row of this.deps.store.listCreatedData(runId)) {
      if (row.cleanup_status !== 'PENDING' && row.cleanup_status !== 'FAILED') continue;
      const spec = JSON.parse(row.cleanup_json!) as CleanupSpec;
      if (spec.method === 'keep') continue;

      let detail = '';
      let ok = true;
      if (spec.method === 'api') {
        const res = await session.context.request.fetch(spec.request.path, {
          method: spec.request.method,
          ...(spec.request.body !== undefined ? { data: spec.request.body } : {}),
          failOnStatusCode: false,
        });
        // 404 conta como desfeito (já não existe); a verificação abaixo decide.
        ok = res.ok() || res.status() === 404;
        detail = `${spec.request.method} ${spec.request.path} → ${res.status()}`;
      }
      if (ok) {
        const check = await session.context.request.get(spec.verify.path, { failOnStatusCode: false });
        const body = await check.text().catch(() => '');
        // Sem expectStatus, a leitura tem de dar 2xx: um 401/500 "não contém o texto" mas não prova nada.
        const statusOk = spec.verify.expectStatus === undefined ? check.ok() : String(check.status()) === spec.verify.expectStatus;
        const textOk = spec.verify.absentText === undefined || !body.includes(spec.verify.absentText);
        ok = statusOk && textOk;
        detail += `${detail ? '; ' : ''}verificação GET ${spec.verify.path} → ${check.status()}` +
          (textOk ? '' : ` ainda contém "${spec.verify.absentText}"`);
      }
      const status = ok ? 'VERIFIED' : 'FAILED';
      this.deps.store.setCleanupStatus(runId, row.id, status, detail);
      results.push({ id: row.id, resource: row.resource, status, detail: this.deps.redactor.text(detail) });
    }
    const open = this.deps.store.listCreatedData(runId).filter((d) => d.cleanup_status === 'UNREGISTERED').map((d) => d.id);
    return { results, unregistered: open.length ? open : undefined };
  }

  // ── Verificação ─────────────────────────────────────────────────────

  async verify(input: VerifyInput) {
    const session = this.s;
    const code = this.requireScenario();
    const timeout = input.timeoutMs ?? 5000;
    let outcome: { passed: boolean; expected: string; actual: string };

    switch (input.kind) {
      case 'ui':
        outcome = await this.poll(timeout, () => this.checkUi(input));
        break;
      case 'persistence': {
        if (input.path) await session.page.goto(input.path, { waitUntil: 'domcontentloaded' });
        else await session.page.reload({ waitUntil: 'domcontentloaded' });
        await session.net.waitQuiet();
        outcome = await this.poll(timeout, () => this.checkUi(input));
        outcome.expected = `após ${input.path ? `abrir ${input.path}` : 'recarregar'}: ${outcome.expected}`;
        break;
      }
      case 'url': {
        if (!input.urlPattern) throw new BrowserError('verify url exige urlPattern');
        const pattern = input.urlPattern;
        const re = pattern.length > 2 && pattern.startsWith('/') && pattern.endsWith('/') ? new RegExp(pattern.slice(1, -1)) : undefined;
        outcome = await this.poll(timeout, async () => {
          const url = session.page.url();
          return { passed: re ? re.test(url) : url.includes(pattern), expected: `URL ${re ? 'casa' : 'contém'} ${pattern}`, actual: url };
        });
        break;
      }
      case 'network':
        outcome = await this.poll(timeout, async () => this.checkNetwork(input));
        break;
      case 'api':
        outcome = await this.checkApi(input);
        break;
      case 'console': {
        const errors = session.console.since(session.windowStart, true);
        const relevant = input.text ? errors.filter((e) => e.text.includes(input.text!)) : errors;
        outcome = {
          passed: relevant.length === 0,
          expected: input.text ? `nenhum erro de console contendo "${input.text}"` : 'nenhum erro de console no cenário',
          actual: relevant.length === 0 ? 'nenhum' : `${relevant.length} erro(s): ${relevant.slice(0, 3).map((e) => e.text.slice(0, 150)).join(' | ')}`,
        };
        break;
      }
    }

    const expected = this.deps.redactor.text(outcome.expected);
    const actual = this.deps.redactor.text(outcome.actual);
    let evidence: { evidenceId: number; path: string } | undefined;
    if (!outcome.passed) {
      const shot = await this.screenshot({ label: `falha-${input.kind}` });
      evidence = { evidenceId: shot.evidenceId, path: shot.path };
    }
    this.deps.store.recordVerification(session.runId, code, {
      kind: input.kind, description: input.description, expected, actual, passed: outcome.passed, evidenceId: evidence?.evidenceId,
      spec: input,
    });
    return { passed: outcome.passed, kind: input.kind, expected, actual, evidence: evidence?.path };
  }

  private async poll(timeoutMs: number, check: () => Promise<{ passed: boolean; expected: string; actual: string }>) {
    const deadline = Date.now() + timeoutMs;
    let last = await check();
    while (!last.passed && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      last = await check();
    }
    return last;
  }

  private async checkUi(input: VerifyInput): Promise<{ passed: boolean; expected: string; actual: string }> {
    if (!input.target) throw new BrowserError(`verify ${input.kind} exige target`);
    const condition = input.condition ?? 'visible';
    const loc = toLocator(this.s.page, input.target);
    const what = describeTarget(input.target);
    const n = await loc.count();

    switch (condition) {
      case 'count':
        if (input.count === undefined) throw new BrowserError('condition count exige count');
        return { passed: n === input.count, expected: `${input.count} × ${what}`, actual: `${n}` };
      case 'hidden': {
        const visible = n > 0 && (await this.anyVisible(loc, n));
        return { passed: !visible, expected: `${what} oculto/ausente`, actual: visible ? 'visível' : n === 0 ? 'ausente' : 'oculto' };
      }
      case 'visible': {
        const visible = n > 0 && (await this.anyVisible(loc, n));
        return { passed: visible, expected: `${what} visível`, actual: n === 0 ? 'ausente' : visible ? 'visível' : 'presente mas oculto' };
      }
      case 'containsText': {
        if (input.text === undefined) throw new BrowserError('containsText exige text');
        const texts = n === 0 ? [] : (await loc.allTextContents()).map((t) => t.replace(/\s+/g, ' ').trim());
        return {
          passed: texts.some((t) => t.includes(input.text!)),
          expected: `${what} contém "${input.text}"`,
          actual: n === 0 ? 'ausente' : texts.slice(0, 3).map((t) => `"${t.slice(0, 120)}"`).join(', '),
        };
      }
      default: {
        if (n !== 1) return { passed: false, expected: `${what} ${condition}`, actual: n === 0 ? 'ausente' : `${n} elementos (ambíguo)` };
        if (condition === 'hasValue') {
          if (input.text === undefined) throw new BrowserError('hasValue exige text');
          const value = await loc.inputValue();
          return { passed: value === input.text, expected: `${what} com valor "${input.text}"`, actual: `"${value}"` };
        }
        if (condition === 'attribute') {
          // Ex.: href de link externo (mailto:, wa.me, instagram) sem abrir app/site de terceiro.
          if (!input.attribute || input.text === undefined) throw new BrowserError('attribute exige attribute e text (trecho esperado)');
          const value = await loc.getAttribute(input.attribute);
          return {
            passed: value !== null && value.includes(input.text),
            expected: `${what} com ${input.attribute} contendo "${input.text}"`,
            actual: value === null ? `sem ${input.attribute}` : `${input.attribute}="${value.slice(0, 200)}"`,
          };
        }
        if (condition === 'checked') {
          const checked = await loc.isChecked();
          return { passed: checked, expected: `${what} marcado`, actual: checked ? 'marcado' : 'desmarcado' };
        }
        const enabled = await loc.isEnabled();
        return {
          passed: condition === 'enabled' ? enabled : !enabled,
          expected: `${what} ${condition === 'enabled' ? 'habilitado' : 'desabilitado'}`,
          actual: enabled ? 'habilitado' : 'desabilitado',
        };
      }
    }
  }

  private async anyVisible(loc: Locator, n: number): Promise<boolean> {
    for (let i = 0; i < Math.min(n, 20); i++) if (await loc.nth(i).isVisible()) return true;
    return false;
  }

  private statusMatches(status: number | undefined, expected: string | undefined): boolean {
    if (status === undefined) return false;
    const want = expected ?? '2xx';
    return /^\dxx$/i.test(want) ? Math.floor(status / 100) === Number(want[0]) : status === Number(want);
  }

  private checkNetwork(input: VerifyInput) {
    if (!input.urlContains) throw new BrowserError('verify network exige urlContains');
    const method = input.method?.toUpperCase();
    const expected = `${method ?? '*'} *${input.urlContains}* → ${input.status ?? '2xx'}`;
    const matches: NetEntry[] = this.s.net
      .since(this.s.windowStart)
      .filter((e) => e.url.includes(input.urlContains!) && (!method || e.method === method) && (e.status !== undefined || e.failure));
    const last = matches.at(-1);
    if (!last) return { passed: false, expected, actual: 'nenhuma request correspondente no cenário' };
    let passed = this.statusMatches(last.status, input.status);
    let actual = summarize(last);
    if (passed && input.bodyContains) {
      passed = (last.responseBody ?? '').includes(input.bodyContains);
      actual += passed ? '' : ` — resposta não contém "${input.bodyContains}"`;
    }
    // Corpo ENVIADO (ex.: PUT de preferência): o que a tela mandou gravar.
    if (passed && input.requestBodyContains) {
      passed = (last.requestBody ?? '').includes(input.requestBodyContains);
      actual += passed ? ` — enviado: ${(last.requestBody ?? '').slice(0, 200)}` : ` — corpo enviado não contém "${input.requestBodyContains}": ${(last.requestBody ?? '').slice(0, 200)}`;
    }
    const extra = [input.bodyContains && `resposta contendo "${input.bodyContains}"`, input.requestBodyContains && `envio contendo "${input.requestBodyContains}"`].filter(Boolean);
    return { passed, expected: extra.length ? `${expected} com ${extra.join(' e ')}` : expected, actual };
  }

  /**
   * Leitura direta (somente GET) com a sessão do navegador, para confirmar estado no servidor.
   * Aceita caminho relativo (baseUrl) ou URL absoluta. Se a aplicação autentica a API por header
   * (Authorization), reaproveita o último header que ela mesma enviou para aquela origem.
   */
  private async checkApi(input: VerifyInput) {
    if (!input.path) throw new BrowserError('verify api exige path (GET)');
    const code = this.currentScenario();
    this.deps.store.logEvent(this.s.runId, this.scenarioId(code), 'inspect.api', { path: input.path });
    const url = new URL(input.path, this.s.baseUrl);
    const authorization = this.s.net.authorizationFor(url.origin);
    const res = await this.s.context.request.get(url.toString(), {
      failOnStatusCode: false,
      ...(authorization ? { headers: { authorization } } : {}),
    });
    const body = (await res.text().catch(() => '')).slice(0, 20_000);
    let passed = this.statusMatches(res.status(), input.status);
    if (passed && input.bodyContains) passed = body.includes(input.bodyContains);
    return {
      passed,
      expected: `GET ${input.path} → ${input.status ?? '2xx'}${input.bodyContains ? ` contendo "${input.bodyContains}"` : ''}`,
      actual: `${res.status()} ${body.slice(0, 300)}`,
    };
  }
}

function describeSimulation(s: Simulation): string {
  const what = s.abort ? 'falha de rede' : s.status !== undefined ? `status ${s.status}` : 'só atraso';
  return `${s.method ?? '*'} *${s.urlContains}* → ${what}${s.delayMs ? ` (+${s.delayMs}ms)` : ''} · aplicada ${s.hits}x${s.remaining >= 0 ? ` · restam ${s.remaining}` : ''}`;
}
