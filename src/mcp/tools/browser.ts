import { z } from 'zod';
import type { BrowserService } from '../../browser/service.ts';
import { Target } from '../../browser/target.ts';
import { CleanupSpec } from '../../state/cleanup.ts';
import { VERIFICATION_KINDS } from '../../state/rules.ts';
import type { StateStore } from '../../state/store.ts';
import { ToolContent, type RegisterTool } from '../tooling.ts';

export function registerBrowserTools(tool: RegisterTool, browser: BrowserService, store: StateStore): void {
  tool(
    'browser_open',
    'Abre o navegador no ambiente do run (plano já aprovado). Com role, reaproveita a sessão salva do papel; fresh=true ignora a sessão salva (login do zero) mantendo o papel para browser_save_auth.',
    { runId: z.string(), role: z.string().optional(), headed: z.boolean().optional().describe('janela visível'), fresh: z.boolean().optional() },
    (a) => browser.open(a),
  );

  tool('browser_save_auth', 'Salva a sessão logada do papel atual para reuso.', {}, () => browser.saveAuth());

  tool('browser_close', 'Fecha o navegador.', {}, () => browser.close());

  tool(
    'navigate',
    'Abre uma URL ou caminho relativo à baseUrl. Devolve URL, status, título e snapshot curto.',
    { url: z.string(), snapshot: z.boolean().optional() },
    (a) => browser.navigate(a),
  );

  tool(
    'snapshot',
    'Árvore de acessibilidade da página (ou de uma região com scope). Prefira isto a screenshot.',
    { scope: Target.optional(), maxChars: z.number().int().positive().optional() },
    (a) => browser.snapshot(a),
  );

  const actFields = {
    action: z.enum(['click', 'fill', 'select', 'check', 'uncheck', 'press', 'hover', 'upload']),
    target: Target,
    value: z.string().optional(),
    valueRef: z.string().optional(),
    valueType: z.string().optional().describe('tipo semântico do dado, ex.: studentName'),
    key: z.string().optional().describe('para press, ex.: Enter'),
    files: z.array(z.string()).optional().describe('para upload, relativos ao projeto'),
    dialog: z.enum(['accept', 'dismiss']).optional(),
  };

  tool(
    'act',
    'Executa ação em um alvo semântico, sob o Action Guard (GREEN livre; YELLOW conforme ambiente; RED bloqueado → act_approved). ' +
      'Devolve só o que mudou (diff, requests, dialogs, dados criados a registrar). ' +
      'Para segredos use valueRef (secret:NOME ou role:<papel>.username|password), nunca o valor. ' +
      'dialog define a resposta a um confirm/alert (padrão: dismiss; aceitar confirmação destrutiva só via act_approved).',
    actFields,
    (a) => browser.act(a),
  );

  tool(
    'act_approved',
    'Executa uma ação RED (excluir, pagar, contratar, permissão crítica, e-mail real…) APÓS aprovação explícita do usuário. ' +
      'Mesmos parâmetros de act + justification (o que será feito e por quê).',
    { ...actFields, justification: z.string().min(10) },
    (a) => {
      const { justification, ...input } = a;
      return browser.act(input, { justification });
    },
  );

  tool(
    'data_register',
    'Registra como desfazer um dado criado pelo teste: id de um item detectado em act.createdData, ou resource para um novo. ' +
      'cleanup: {method:"api", request:{method,path,body?}, verify} | {method:"manual", note, verify} | {method:"keep", reason}. ' +
      'verify: {path (GET), expectStatus? | absentText?}.',
    {
      runId: z.string(),
      id: z.number().int().optional(),
      resource: z.string().optional(),
      extId: z.string().optional(),
      cleanup: CleanupSpec,
    },
    (a) => {
      const row = store.registerCreatedData(a.runId, a);
      return { id: row.id, resource: row.resource, extId: row.ext_id, status: row.cleanup_status };
    },
  );

  tool(
    'cleanup_run',
    'Executa as limpezas registradas e verifica a remoção. Itens não registrados são listados.',
    { runId: z.string() },
    (a) => browser.cleanup(a.runId),
  );

  tool(
    'verify',
    'Executa e registra uma verificação no cenário atual; o resultado observado é capturado pelo código. ' +
      'ui/persistence: target + condition (visible|hidden|containsText|hasValue|enabled|disabled|checked|count|attribute: attribute + text contido). ' +
      'url: urlPattern (texto ou /regex/). network: urlContains (+method, status "201"|"2xx", bodyContains). ' +
      'api: path GET relativo ou URL absoluta da API (+status, bodyContains; reaproveita o Authorization que a aplicação usa). persistence recarrega (ou abre path) antes de checar. ' +
      'console: sem erros no cenário (ou sem erros contendo text). Falha gera screenshot automaticamente.',
    {
      kind: z.enum(VERIFICATION_KINDS),
      description: z.string().min(3).describe('o que está sendo verificado; repetir a mesma descrição refaz a checagem'),
      target: Target.optional(),
      condition: z.enum(['visible', 'hidden', 'containsText', 'hasValue', 'enabled', 'disabled', 'checked', 'count', 'attribute']).optional(),
      attribute: z.string().optional().describe('para condition attribute, ex.: href'),
      text: z.string().optional(),
      count: z.number().int().nonnegative().optional(),
      urlPattern: z.string().optional(),
      method: z.string().optional(),
      urlContains: z.string().optional(),
      status: z.string().optional(),
      path: z.string().optional(),
      bodyContains: z.string().optional().describe('trecho da resposta'),
      requestBodyContains: z.string().optional().describe('network: trecho do corpo enviado (ex.: PUT)'),
      timeoutMs: z.number().int().positive().max(30_000).optional(),
    },
    (a) => browser.verify(a),
  );

  tool(
    'browser_viewport',
    'Redimensiona a janela para validar responsivo: preset mobile (390x844), tablet (820x1180), desktop (1440x900) ou width/height.',
    { preset: z.enum(['mobile', 'tablet', 'desktop']).optional(), width: z.number().int().min(280).max(3840).optional(), height: z.number().int().min(400).max(2400).optional() },
    (a) => browser.viewport(a),
  );

  tool(
    'network_simulate',
    'Simula resposta de API só no navegador do teste (não chega ao servidor) para validar estados de erro, vazio e carregamento: ' +
      'status (ex.: 500) + body opcional, delayMs (lentidão), abort (queda de rede), times (padrão: até o fim do cenário). Limpa sozinho ao fim do cenário.',
    {
      urlContains: z.string().min(2),
      method: z.string().optional(),
      status: z.number().int().min(100).max(599).optional(),
      body: z.string().optional().describe('JSON da resposta simulada, ex.: [] para lista vazia'),
      delayMs: z.number().int().positive().max(30_000).optional(),
      abort: z.boolean().optional(),
      times: z.number().int().positive().optional(),
    },
    (a) => browser.simulate(a),
  );

  tool('network_simulate_clear', 'Remove as simulações de rede ativas.', {}, () => browser.clearSimulations());

  tool(
    'network',
    'Requests (documento/XHR/fetch) do cenário atual, resumidas. Com id, detalhes sanitizados (headers e corpos).',
    {
      urlContains: z.string().optional(),
      method: z.string().optional(),
      id: z.number().int().optional(),
      limit: z.number().int().positive().optional(),
    },
    (a) => browser.network(a),
  );

  tool(
    'console',
    'Mensagens de console (erros, avisos, exceções) do cenário atual.',
    { errorsOnly: z.boolean().optional(), limit: z.number().int().positive().optional() },
    (a) => browser.consoleMessages(a),
  );

  tool(
    'screenshot',
    'Salva screenshot como evidência (campos sensíveis mascarados). Só devolve a imagem ao modelo com view=true.',
    { target: Target.optional(), fullPage: z.boolean().optional(), label: z.string().optional(), view: z.boolean().optional() },
    async (a) => {
      const { png, ...saved } = await browser.screenshot(a);
      if (!a.view) return saved;
      return new ToolContent([
        { type: 'text', text: JSON.stringify(saved) },
        { type: 'image', data: png.toString('base64'), mimeType: 'image/png' },
      ]);
    },
  );
}
