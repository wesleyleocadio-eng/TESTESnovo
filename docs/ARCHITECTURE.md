# NOVO QA — Arquitetura V1

Agente local de QA. Claude Code é o QA; o código fornece ferramentas, estado, segurança e evidência.

```text
TypeScript (MCP novo-qa) = ferramentas e infraestrutura
Claude Code              = raciocínio de QA (entender, planejar, decidir, investigar, classificar)
Playwright               = mãos e olhos no navegador
SQLite                   = memória operacional (runs, cenários, ações, evidências)
knowledge/ (YAML, git)   = conhecimento acumulado com proveniência
Jira / Confluence / Figma = demanda, documentação, referência visual
```

Prioridades, em ordem: qualidade real do teste → nunca PASS sem evidência → segurança → investigação → reuso de conhecimento → baixo desperdício de tokens → automação confiável → simplicidade → velocidade.

---

## 1. Decisões de design (regras impostas pelo código)

### D1. Execution Knowledge é subproduto da execução

As ferramentas de navegador só aceitam **alvos semânticos** — nunca coordenadas nem refs efêmeras:

```json
{ "role": "button", "name": "Salvar" }
{ "label": "Nome" }
{ "placeholder": "Buscar aluno" }
{ "testId": "report-filter" }
{ "text": "Relatório gerado" }
{ "css": "[data-qa=submit]" }          // último recurso, só seletor estável
{ "role": "row", "name": "Maria", "within": { "role": "table", "name": "Alunos" } }
```

Ordem de preferência: `role+name → label → placeholder → testId → text → css estável`. Alvo ambíguo não é erro genérico: a ferramenta devolve os candidatos para o Claude refinar com `within`.

Toda ação vai para a tabela `actions`. Um alvo é **validado** quando a ação teve sucesso **e** o cenário teve verificação aprovada depois dela. Ao final do run, as ações validadas são exportadas para `knowledge/<projeto>/execution/<módulo>.json`:

```json
{
  "route": "/admin/reports",
  "action": "click",
  "target": { "role": "button", "name": "Salvar" },
  "valueType": null,
  "validatedIn": ["run_20261023_01"],
  "lastSeen": "2026-10-23",
  "failures": 0
}
```

O Claude não "registra seletores": o que funcionou é registrado automaticamente. A automação reutiliza exatamente esses localizadores.

### D2. PASS sem evidência é rejeitado pelo código

O Claude não narra verificações: ele as **executa** via `verify`, e o valor *observado* é capturado pelo código.

| `verify.kind` | O que o código checa | Força |
|---|---|---|
| `ui` | elemento/texto visível, estado (enabled, checked, value) | fraca |
| `url` | URL/rota atual | fraca |
| `network` | request feita com método/rota/status (e trecho do body) | forte |
| `api` | chamada GET direta de leitura para confirmar estado | forte |
| `persistence` | reload/reabertura e checagem de novo | forte |
| `console` | ausência/presença de erros | complementar |

Regras de `scenario_complete`:

| Status | Exigência mínima |
|---|---|
| `PASSED` | ≥ 1 verificação aprovada; cenários P0/P1 com ação de escrita exigem ≥ 1 verificação **forte** |
| `FAILED` | ≥ 1 verificação reprovada + evidência (screenshot/trace) + `classification` |
| `BLOCKED` | motivo + `classification` (ENVIRONMENT/TEST_DATA/REQUIREMENT_AMBIGUITY/…) |
| `NEEDS_REVIEW` | motivo |
| `NOT_EXECUTED` | motivo |

`PRODUCT_BUG` exige que a investigação tenha consultado ao menos network **ou** console **ou** reprodução — senão a classificação é rebaixada para `UNKNOWN`/`NEEDS_REVIEW`.

### D3. Confidence vem de rubrica, não do modelo

Calculada pelo código a partir dos registros:

| Nível | PASSED | FAILED |
|---|---|---|
| HIGH | ≥ 2 verificações, incluindo uma forte, sem erro de console inexplicado | reproduzido ≥ 2× e investigado (network/console) |
| MEDIUM | 1 verificação forte, ou ≥ 2 fracas | reproduzido 1× com evidência |
| LOW | só verificação fraca | evidência sem investigação |

O Claude pode **rebaixar** o nível (com motivo), nunca elevar acima da rubrica. O número (HIGH 0.9 / MEDIUM 0.7 / LOW 0.4) existe só para métricas. O mesmo princípio vale para *automation suitability*: o Claude avalia fatores (estabilidade, dados, dependências externas, captcha/MFA, visual, valor de regressão) e o código calcula o score.

### D4. Contexto limitado por lotes de execução

O maior custo é o crescimento do histórico, não os documentos. Por isso:

- A sessão principal (Orchestrator) faz discovery, risco e plano, e **nunca vê snapshots de página**.
- A execução roda no subagente `test-executor` em **lotes**, com contexto limpo:
  - risco HIGH: 3–4 cenários por lote; MEDIUM: 5–6; LOW: até 8.
  - briefing gerado do SQLite: Context Package + cenários do lote + execution knowledge do módulo.
  - retorno ao Orchestrator: resumo ≤ ~300 tokens por lote (status, findings, cenários exploratórios criados).
- Checkpoint no SQLite a cada cenário. O `/qa-resume` usa o mesmo mecanismo: um novo lote começa no próximo cenário pendente.
- `act` não devolve a página inteira; devolve o **resumo da mudança**: URL mudou?, diff do snapshot de acessibilidade (truncado), XHRs (método, rota, status), erros de console, dialogs. O snapshot completo só sai sob demanda e com `scope`.

### D5. Automação sempre em contexto novo

A automação **sempre** é criada neste repositório, separada por projeto (`automation/<projeto>/`, ver §11), com POM/fixtures próprios do projeto.

`/qa KEY --automate` termina o teste manual com `automation_spec` (gera `AUTOMATION.md`, `test-data.json`, `execution-knowledge.json`) e então dispara a etapa de automação **em contexto novo** (subagente com as instruções da skill `automate`), que lê só esses artefatos + o repositório de destino. `/automate KEY` faz o mesmo isoladamente.

Isso testa o próprio critério: `AUTOMATION.md` tem de bastar. Quando a etapa de automação precisa redescobrir algo da aplicação, registra um evento `spec_gap` — métrica de qualidade do spec.

Loop de validação: executa → falha → classifica (`AUTOMATION_BUG` / `PRODUCT_BUG` / `DATA_PROBLEM` / `ENVIRONMENT`) → corrige **somente** `AUTOMATION_BUG` → reexecuta, até `1 + maxFixAttempts` tentativas (imposto pela ferramenta). Falha de produto nunca é "corrigida" no teste para passar.

Implementado (M8):
- Suitability: o Claude avalia fatores (estabilidade, repetibilidade, dependência externa, passo humano, visual, valor de regressão); o código calcula o score, combinando com status, confidence e ações validadas do manual. HIGH (≥80) entra; MEDIUM só com motivo; LOW nunca; só cenário PASSED.
- `AUTOMATION.md` é gerado do banco: passos reais executados (linhas Playwright), assertions derivadas das verificações aprovadas (alvo e condição gravados no `verify`), login/setup, massa de exemplo (só valor literal, nunca segredo), limpeza registrada, seletores, evidências e o que ficou fora.
- Estrutura `automation/<projeto>/`: `env.ts` regenerado da config (recusa prod; senha só via .env), `playwright.config.ts` (sem retry; `actionTimeout` para o erro mostrar o seletor), `fixtures/index.ts` (guard: DELETE da página bloqueado salvo `allowDelete`; `unique()` para massa).
- Validação roda cada teste 2× em paralelo: na primeira bateria pegou colisão de massa com `Date.now()` — por isso o `unique()`. Entregue = validação sem falha nem flaky.
- `/automate` (e `/qa --automate`) delega a geração e o ciclo de correção a um subagente de contexto novo, que só lê o AUTOMATION.md e o projeto; o que tiver de redescobrir é reportado como lacuna do spec.

### D6. Conhecimento compactado nunca fica órfão da fonte

Todo resumo/compactação guarda a fonte e a versão:

```yaml
source: { type: confluence, reference: "123456", version: 14, hash: 9f2c… }
compacted_at: 2026-10-23
```

`context_build` compara com a fonte em cache; resumo desatualizado é marcado `stale` e não é usado como `CONFIRMED` até ser regenerado. Resumo sem fonte é rejeitado na validação.

---

## 2. Arquitetura

```text
┌──────────────────── Claude Code ─────────────────────────────────────┐
│ Sessão principal = QA Orchestrator  (skills /qa /qa-resume /retest /automate)
│   ├─ subagente test-executor   (lotes de cenários, contexto limpo)    │
│   └─ subagente bug-investigator (SHOULD — só em anomalia complexa)    │
└───────────────┬───────────────────────────────┬──────────────────────┘
                │ MCP stdio                     │ MCP (global, já conectado)
┌───────────────▼────────────────────┐   ┌──────▼─────────────┐
│ novo-qa MCP server (TypeScript)    │   │ Atlassian MCP      │
│  browser/   Playwright persistente │   │ fallback / JQL ad-hoc
│  guard/     Action Guard           │   └────────────────────┘
│  security/  segredos + redação     │
│  state/     SQLite (node:sqlite)   │──► data/novo-qa.db
│  sources/   cache de digests       │──► .cache/
│  context/   Context Package        │
│  knowledge/ validação/proveniência │──► knowledge/
│  evidence/  screenshot/trace       │──► runs/<KEY>/<runId>/
│  automation/ spec + runner         │──► automation/<projeto>/
│  reporting/ + metrics/             │──► reports/
└────────────────────────────────────┘
```

Jira e Confluence são lidos **pelo Atlassian MCP** (o servidor novo-qa não fala com a Atlassian). Figma é aberto **pelo navegador** (sessão Playwright do novo-qa).

Por que MCP próprio em vez do Playwright MCP oficial: Action Guard, redação, gravação de estado/execution knowledge e saídas compactas exigem controle da camada de ferramenta; e o navegador precisa ficar vivo entre chamadas (um servidor stdio resolve sem daemon).

---

## 3. Fluxo `/qa KEY [--explore] [--automate]`

```text
1 DISCOVERY      context_build(KEY) → Context Package (~1–2k tokens)
                 Claude decide se busca mais: issue relacionada, Confluence, Figma, bugs históricos
2 UNDERSTANDING  regras, módulos, papéis; ambiguidade → REQUIREMENT_AMBIGUITY
3 RISK           impacto × probabilidade por área → profundidade por cenário
4 PLAN           plan_save → SQLite + runs/<KEY>/<runId>/plan.md
                 pausa para aprovação do plano (padrão V1)
5 EXECUTION      lotes no test-executor: OBSERVE → DECIDE → ACT → VERIFY → RECORD
                 anomalia → EXP-NNN; investigação escala: diff → network → console → API
                 → screenshot → knowledge → Jira relacionado
6 CLASSIFY       PRODUCT_BUG | AUTOMATION_FAILURE | ENVIRONMENT_FAILURE | TEST_DATA_FAILURE
                 | REQUIREMENT_AMBIGUITY | EXPECTED_BEHAVIOR | UNKNOWN
7 CLEANUP        cleanup_run → verificação do cleanup
8 REPORT         resumo no terminal + reports/<KEY>/<runId>.md
9 LEARN          knowledge_propose → knowledge/<projeto>/_staging/
--automate:
10 SPEC          automation_spec → automation/<KEY>/
11 AUTOMATE      contexto novo: gera .spec.ts → executa → classifica → corrige → entrega
```

`--explore` aumenta o orçamento exploratório (mais EXP por área de risco, heurísticas de borda). `/retest KEY` cria run filho com FAILED/BLOCKED + vizinhos de risco. `/resume KEY` retoma o último run não finalizado.

---

## 4. Ferramentas MCP

| Grupo | Ferramentas |
|---|---|
| Contexto | `context_build`, `digest_get(source, key, version)`, `digest_put(source, key, version, digest)` |
| Estado | `run_start`, `run_status`, `run_complete`, `run_abort`, `plan_save`, `plan_approve` (sempre "ask"), `scenario_start`, `scenario_complete`, `scenario_add` |
| Navegador | `browser_open(env, role)`, `navigate`, `snapshot(scope?)`, `act(action, target, value \| valueRef)`, `verify(kind, …)`, `network(filter)`, `console`, `screenshot(view?)` |
| Guard | embutido em `act`; ações RED só via `act_approved` |
| Dados | `data_register` (completa os candidatos detectados em `act.createdData`), `cleanup_run` (executa e verifica) |
| Conhecimento | `knowledge_propose` → `_staging/` (revisão humana); execution knowledge fundido em `knowledge/<projeto>/execution/<módulo>.json` no `run_complete` (módulo = primeiro de `plan_save.modules`) |
| Fluxo /qa | `batch_brief` (lote conforme risco + briefing do executor a partir do SQLite; cenário interrompido vem com o que já foi verificado), `plan_view`, `retest_seed` (o que não passou no run pai + o que passou, para vizinhos), `report_build` (com comparação no reteste), `config_reload` |
| Automação | `automation_assess` (suitability por rubrica), `automation_spec` (AUTOMATION.md + scaffold do projeto), `automation_run` (tentativa ou validação 2×; limite de correções) |

Descrições de ferramenta curtas: o schema é pago em toda chamada.

Verificações, evidências, ações e eventos de investigação **não** são ferramentas: são gravados internamente pelas ferramentas de navegador (`verify`, `screenshot`, `act`, `network`, `console`). O modelo não consegue registrar uma verificação que não executou.

---

## 5. Modelo de dados

### SQLite (operacional)

```text
runs(id, issue_key, project, env, mode[manual|explore|automate|retest], parent_run_id,
     status, current_scenario, recommendation, started_at, ended_at)
scenarios(id, run_id, code, title, priority[P0..P3], types, risk,
     origin[planned|exploratory|retest], parent_code, preconditions, steps, expected,
     status, confidence, classification, observed, automation_suitability,
     automation_approved, started_at, ended_at)
actions(id, run_id, scenario_id, seq, action, target_json, value_ref, guard_level,
     ok, error, url, duration_ms, ts)
verifications(id, scenario_id, kind, description, expected, actual, passed, strength, evidence_id)
evidence(id, run_id, scenario_id, kind, path, sha256, sanitized, meta)
findings(id, run_id, scenario_id, classification, severity, title, repro, investigated_json,
     status, jira_key)
created_data(id, run_id, scenario_id, resource, ext_id, cleanup_json, cleanup_status, verified_at)
approvals(id, run_id, action, target, level, decision, ts)
events(id, run_id, scenario_id, type, payload, ts)
model_usage(session_id, agent, run_id, scenario_id, input, output, cache_read, cache_write, ts)
cache_entries(source, key, version, hash, path, fetched_at)
```

### knowledge/ (arquivos versionados)

```yaml
# knowledge/<projeto>/modules/<módulo>.yaml
module: reports
summary: …
source: { type: confluence, reference: "123456", version: 14, hash: 9f2c… }
statements:
  - statement: "Site User não acessa Admin Reports"
    kind: business_rule          # business_rule | behavior | permission | risk | regression
    status: CONFIRMED            # DOCUMENTED | CONFIRMED | OBSERVED | INFERRED | SUSPECTED
    confidence: HIGH
    source: { type: jira, reference: DUCO-421 }
```

Regras de proveniência (validadas pelo código):

- Comportamento de cenário `FAILED` nunca entra como `business_rule`; entra como `regression`/bug histórico.
- Propostas do Claude chegam em `_staging/` como `OBSERVED`/`INFERRED`.
- `CONFIRMED` exige fonte documental (Jira/Confluence) ou aprovação humana.

---

## 6. Contexto e tokens

Métrica-alvo: `tokens / decisão útil` (decisão útil = cenário concluído, verificação, finding classificado, cenário exploratório criado).

| Desperdício | Medida |
|---|---|
| Overhead fixo | `CLAUDE.md` ≤ ~1,5k tokens e estável (prompt cache); skills com `references/` sob demanda |
| Crescimento do histórico | D4 — lotes em subagente, briefing do SQLite, retorno resumido |
| Snapshot por ação | `act` devolve só o resumo da mudança |
| Network/console | buffer no servidor; resumo ao Claude, detalhe sob demanda |
| Screenshots | gravadas em disco; ao modelo só com `view:true` |
| Jira/Confluence | MCP com `fields` selecionados e `responseContentFormat: markdown`; cache de digest por `updated`/`version` (§9) |
| Login repetido | `storageState` por ambiente+papel |
| Redescoberta | execution knowledge do módulo carregado quando o módulo é tocado |

Progressive disclosure: `CLAUDE.md → knowledge/<projeto>/project.md → módulo → ticket → (se necessário) relacionados, Confluence, Figma, bugs históricos`.

### Medição (M7)
- Fonte de tokens: transcripts JSONL do Claude Code (`~/.claude/projects/<projeto>/`, incluindo `subagents/`), lidos por `src/metrics/transcripts.ts` — formato não é API pública, por isso fica isolado ali. Uma chamada ao modelo aparece em várias linhas com o mesmo `message.id`: deduplicar é obrigatório (sessão de desenvolvimento: 570 linhas = 149 chamadas).
- Atribuição por janela: run = da descoberta (`context_build`/digest do card) ao fim; só sessões que usaram ferramentas `novo-qa` na janela; cenário = `scenario_start` → `scenario_complete`.
- "Tokens novos" = entrada + escrita de cache + saída; leitura de cache à parte. Na sessão de desenvolvimento deste projeto: ~1,25M novos contra ~45,5M lidos do cache — o crescimento de contexto domina o volume, o que justifica D4.
- `report_build` e `metrics_run` (ou `npm run metrics -- <card>`): tokens por run/cenário/bug/decisão útil, tempo, cache de contexto, chamadas, ações, screenshots. `npm run metrics -- --schema`: custo fixo por ferramenta (hoje ~5,7k tokens para 32 ferramentas; `act`/`act_approved` repetem o schema de alvo — candidato a enxugar quando houver uso real medido).
- Automação (sucesso, flaky) entra no M8.

---

## 7. Integração com Claude Code

- Comandos como skills: `.claude/skills/{qa,qa-resume,retest,automate}/SKILL.md` (`/regression` é FUTURE). `/resume` nativo do Claude Code retoma conversas, por isso a retomada de run é `/qa-resume`. Etapas comuns (lotes, limpeza, aprendizado, fechamento) ficam em `qa/references/execute-and-close.md`.
- Subagentes: `test-executor` (MUST), `bug-investigator` (SHOULD). Modelo do executor: herda o da sessão (comparar com Sonnet nas métricas do M7).
- `.claude/settings.json`:
  - `mcp__novo-qa__act_approved` sempre em **ask** — a aprovação de ação RED é o prompt de permissão do Claude Code; o Claude não se autoaprova.
  - hook `PreToolUse` (Bash/PowerShell, `.claude/hooks/guard-shell.mjs`) bloqueia interpretador executando driver de navegador (inline ou script que o importa) e DELETE HTTP direto; permite `npx playwright test`, `npx vitest`, instalação e leitura de código.
  - hooks `Stop`/`SubagentStop` leem o transcript JSONL e gravam `model_usage`.

---

## 8. Integração com Playwright

Execução manual (MCP): contexto persistente por run (`channel: chrome` opcional via `NOVO_QA_BROWSER_CHANNEL`), alvos semânticos (D1), `locator.ariaSnapshot()` para observação, trace por cenário mantido só em falha, screenshot com `mask` em campos sensíveis.

Detalhes que importam:
- Alvo que casa com 0 ou vários elementos vira erro com candidatos e contexto (linha/seção), nunca `nth()` silencioso.
- Status de request é registrado ao receber os headers (`response`): se a página navegar logo após um `fetch` (ex.: login), o corpo é cancelado e `requestfinished` nunca chega.
- Verificação reprovada gera screenshot automaticamente (satisfaz a evidência exigida por FAILED).
- "Reprodução" é objetiva: a mesma verificação (kind + descrição) refeita e reprovada de novo.
- Ações de setup fora de cenário (ex.: login) entram no execution knowledge como `(setup)` se alguma verificação aprovada vier depois.
- App fixture local (`npm run fixture`, porta 4400) para testar as ferramentas sem sistema real.

Automação gerada: seletores do execution knowledge; respeita POM/fixtures/helpers do repositório de destino (lidos antes de gerar); fixture de segurança aborta se `baseURL` não for ambiente permitido; loop de validação conforme D5.

---

## 9. Jira / Confluence / Figma

| | Leitura | Escrita | Cache |
|---|---|---|---|
| Jira | Atlassian MCP (`getJiraIssue` com `fields` selecionados, markdown) | V1: só rascunho no relatório; publicar exige aprovação explícita | digest em `.cache/jira/` por `updated` |
| Confluence | Atlassian MCP (`getConfluencePage`) → resumo com fonte (D6) | não | digest em `.cache/confluence/` por `version` |
| Figma | navegador (sessão Playwright, login Figma via `storageState`); canvas exige screenshot | não | screenshot em `.cache/figma/` por URL do nó |

Como não há REST próprio, o cache guarda o **digest compacto** que o Claude produz ao ler a fonte, não a resposta bruta:

```text
1. MCP getJiraIssue(KEY, fields=["updated"])        ← chamada barata
2. digest_get("jira", KEY, updated)
   hit  → usa o digest (~300–800 tokens)
   miss → MCP getJiraIssue(KEY, fields selecionados) → Claude compacta → digest_put(...)
```

O digest guarda fonte e versão (D6); o original continua sendo a fonte da verdade.

Medido no GURUJA-9002 (2026-10-23):

| Leitura | Tamanho |
|---|---|
| `getJiraIssue(fields=["updated"])` | ~350 caracteres (~90 tokens) |
| leitura completa com `comment` | ~45 mil caracteres (~11k tokens) — o MCP devolve os comentários **duas vezes** (`fields.comment` e `comments`) quando o campo `comment` é pedido |
| digest | ~3,1 mil caracteres |
| Context Package (`context_build`) | ~855 tokens |

Comentários não são opcionais: nesse card eles traziam o endpoint correto, o resultado do ciclo anterior e a suspeita do dev de ambiente desatualizado — e por isso entram no digest e no Context Package. Limite do digest: 8 mil caracteres (acima disso é recusado para forçar compactação).

---

## 10. Segurança

- Segredos só em `.env`/variáveis de ambiente (gitignored). O Claude usa `valueRef: "secret:GURUJA_ADMIN_PASSWORD"`; o servidor injeta o valor.
- Redação em toda saída (ferramentas, logs, evidências, relatório): valores exatos de segredos conhecidos, `Authorization`/`Cookie`/`Set-Cookie`, JWT, padrões de token, cartão (Luhn), campos de senha.
- Action Guard (`config/qa-policy.yaml`):
  - GREEN — autônomo (navegar, pesquisar, filtrar, ordenar, screenshot, leitura).
  - YELLOW — exige `allowDataCreation: true`. POST 2xx disparado por ação YELLOW/RED vira candidato a limpeza (id extraído da resposta); `run_complete` só passa com cada item VERIFIED ou KEPT (com motivo).
  - RED — só via `act_approved` (delete relevante, pagamento, contratação, permissão crítica, e-mail real, irreversível).
  - Classificação = intenção declarada + heurística sobre o alvo; na dúvida, sobe o nível.
- `prod`: somente GREEN, sem exceção.
- Trace do Playwright guarda em texto puro os valores digitados (`fill`): é gravado só durante o cenário, mantido só em FAILED e **sanitizado dentro do zip** antes de virar evidência (`src/security/trace.ts`). Screenshots do screencast do trace não recebem máscara (campos de senha já aparecem como pontos).
- `confirm()`/`alert()` são **recusados por padrão**; aceitar exige `dialog: "accept"` explícito na ação.
- `headers()` do Playwright já omite `cookie`/`set-cookie`; demais headers sensíveis são redigidos.
- Rede de segurança: `DELETE` vindo da página é abortado fora de `act_approved` (pega botão de nome inofensivo que exclui). Domínios de pagamento/e-mail: FUTURE.
- Classificação = palavra-chave no texto semântico do alvo (nome, label, testId, texto, aria-label, title); clique sem texto legível sobe para YELLOW; confirmação destrutiva só é aceita em `act_approved`.
- Limites conhecidos: exclusão via POST (ex.: `POST /x/1/delete`) com nome inofensivo não é pega pela rede de segurança; em `prod` o POST de login é necessário, então não há bloqueio de escrita no nível de rede — a proteção em prod é a classificação + só GREEN.

---

## 11. Estrutura do repositório

```text
NEW QA/
├── CLAUDE.md
├── .mcp.json
├── .claude/
│   ├── settings.json
│   ├── skills/{qa,qa-resume,retest,automate}/SKILL.md (+ references/)
│   └── agents/{test-executor,bug-investigator}.md
├── config/{projects.yaml, environments.yaml, qa-policy.yaml}
├── docs/ARCHITECTURE.md
├── knowledge/<projeto>/
│   ├── project.md            porta de entrada + índice de módulos
│   ├── modules/<m>.yaml      product knowledge
│   ├── execution/<m>.json    execution knowledge (D1)
│   ├── tests/<m>.yaml        riscos, cenários-chave, regressões, bugs históricos
│   └── _staging/
├── src/{mcp,browser,guard,security,state,sources,context,knowledge,evidence,automation,reporting,metrics}/
├── src/cli.ts                novo-qa doctor | report | metrics | cleanup
├── test/                     vitest + test/fixture-app/
├── automation/<projeto>/
│   ├── playwright.config.ts
│   ├── pages/  fixtures/  helpers/     POM do projeto, reutilizado entre cards
│   ├── specs/<KEY>/                    AUTOMATION.md, test-data.json, execution-knowledge.json
│   └── tests/<KEY>/*.spec.ts
└── (gitignored) runs/ reports/ .cache/ data/ .env
```

Credenciais e dados do ambiente (URL, papéis, usuários, MFA/captcha, se pode criar dados) **não são pré-configurados**: o `/qa` verifica o que falta para o ambiente e pede antes de abrir o navegador. Valores sensíveis vão para o `.env`, nunca para o chat.

---

## 12. Escopo e milestones

- **MUST:** M0–M6, M8.
- **SHOULD:** M7 completo, M9, `bug-investigator`, bloqueio de rede.
- O conhecimento começa do zero (os planos do `qa-workflow-full-cycle` não são importados).
- **FUTURE:** `/regression <module>`, publicação no Jira/Confluence, dashboard, flaky entre runs, busca semântica.

| # | Milestone | Critério de aceite |
|---|---|---|
| M0 | Bootstrap: git, TS, vitest, config loader, redação, `doctor` | `npm test` verde; `doctor` reporta .env/Jira/ambientes; redação cobre token, JWT, cartão, segredo exato |
| M1 | SQLite + MCP skeleton + ferramentas de estado | servidor visível no Claude Code; regras D2/D3 de `scenario_complete` com testes |
| M2 | Navegador: sessão, snapshot/diff, `act` semântico, `verify`, network/console, screenshot com máscara, login por `valueRef` | integração contra fixture app; export de execution knowledge (D1); nenhum segredo nas saídas |
| M3 | Action Guard + cleanup | "Excluir" sem aprovação é bloqueado; `prod` bloqueia YELLOW; criar → cleanup → verificar |
| M4 | Digests (Jira/Confluence via MCP) + cache + Context Package | card real → pacote ≤ ~2k tokens; card não alterado = digest hit sem leitura completa; D6 com teste |
| M5 | `/qa` ponta a ponta (+ `--explore`) | card real em dev: plano aprovado, lotes (D4), evidência em falha, relatório, staging de knowledge; toda PASS com verificação |
| M6 | `/qa-resume`, `/retest` | sessão interrompida → retoma no próximo pendente sem repetir; retest só FAILED/BLOCKED + vizinhos |
| M7 | Métricas | `novo-qa metrics <runId>`: tokens por run/cenário/bug, tempo, cache hit, screenshots, chamadas, ações |
| M8 | Automação (D5) | fixture app + card real: spec no padrão do destino, executado e verde; falha de produto não mascarada; `spec_gap` medido |
| M9 | Figma pelo navegador | card com link → frame aberto e capturado → comparação visual no relatório |

Cada milestone: IMPLEMENT → TEST → VALIDATE → commit-ready → aprovação → próximo.

---

## 12.1 Primeiro run real (GURUJA-9002, 2026-10-26) — o que mudou

| Achado no uso real | Mudança |
|---|---|
| Verificar `mailto:`/`wa.me`/Instagram sem abrir apps externos | `verify` ui `condition: "attribute"` (+ `toHaveAttribute` na automação) |
| API do app autentica por header, `verify api` levava 401 | `verify api` reaproveita o `Authorization` que a própria aplicação enviou para a origem; aceita URL absoluta |
| Cenários BLOCKED por causa passageira não podiam ser refeitos | `scenario_reopen` (BLOCKED/NOT_EXECUTED/NEEDS_REVIEW); só a tentativa atual conta para concluir |
| Login do zero sem perder o papel | `browser_open(fresh: true)` |
| Executor classificou ambiente cedo demais após queda do navegador | instrução: confirmar com login do zero antes de ENVIRONMENT_FAILURE |
| Reconectar o MCP a cada correção | `src/mcp/launcher.ts`: supervisor recarrega o servidor quando `src/` muda, só sem chamada em andamento e sem navegador aberto (trava `data/browser-session.lock` com PID) |
| Evidência em vídeo | `evidence.video: always` — vídeo da sessão com capítulos por cenário, no relatório |
| Hook barrava `sed`/`tsc` em arquivo que importa Playwright | hook só considera arquivo **executado** por interpretador |
| `cleanup_run` falhava em ambiente sem criação de dados mesmo sem nada a limpar | sem itens pendentes, responde "nada a limpar" |
| "Tokens: N" no relatório era redigido (par chave=valor) | rótulo "Uso do modelo"; redator não re-redige o que já foi redigido; segredos de mesmo valor têm rótulo com todos os nomes |

| Corpo de resposta com erro (500 com stack trace) só existia em memória | toda resposta de API ≥ 400 vira evidência `*-http-<status>-<id>.txt`, sanitizada (até 15 por cenário) |
| Resultado final classificado errado (PRODUCT_BUG que era divergência de requisito) | `scenario_reclassify` (FAILED/NEEDS_REVIEW/BLOCKED, justificativa obrigatória, regras de conclusão reaplicadas, seção "Reclassificações" no relatório) |
| CA de responsivo não testável | `browser_viewport` (mobile/tablet/desktop ou tamanho livre; não emula toque/user-agent) |
| CA de estados de erro/vazio/carregamento não testável | `network_simulate` / `network_simulate_clear`: resposta simulada só no navegador do teste (status/body, atraso, queda), limpa ao fim do cenário |
| PUT de preferência: conferir o que foi **enviado** | `verify network` com `requestBodyContains` |
| Supervisor perdia mensagens durante a troca de processo e travava a recarga | fila durante a troca + chamada sem resposta há > 2 min não bloqueia (vale a partir da próxima sessão do Claude Code, que inicia o supervisor novo) |

Achados do produto/ambiente (fora do código do NOVO QA): o host dev serviu dois builds intermitentes (antigo e facelift); o Guruja aceita uma sessão por usuário (logins paralelos do usuário de teste derrubam a execução); sessão derrubada fica em tela de erro com dados do aluno.

## 13. Riscos conhecidos

1. Acessibilidade pobre no app-alvo → fallback testId/texto/css + screenshot; medir no M5.
2. Uso de tokens via transcript JSONL pode mudar de formato → parser isolado e testado.
3. Bypass do Guard via shell → hook heurístico reduz, não é sandbox (ex.: script que importa o driver indiretamente passa). A aprovação RED depende do prompt de permissão "ask" do Claude Code: em modo que ignora permissões (bypass), a proteção cai para a classificação + bloqueio de rede.
4. MFA/captcha/SSO → `storageState` gerado manualmente uma vez.
5. Ambiente dev compartilhado → falsos positivos (`TEST_DATA_FAILURE`); cleanup confiável.
6. `node:sqlite` experimental → acesso encapsulado em `state/`; troca por `better-sqlite3` é local.
7. Paths com acento no Windows → testar o runner cedo.
8. Digest produzido pelo Claude pode perder detalhe → schema fixo, critérios de aceite copiados literalmente, e o original é relido quando há anomalia ou ambiguidade.

---

## 14. Decisões tomadas (2026-10-23)

| # | Decisão |
|---|---|
| 1 | Jira/Confluence lidos pelo Atlassian MCP; cache de digests (§9) |
| 2 | Automação sempre neste repositório, em `automation/<projeto>/` |
| 3 | Ambiente, papéis, usuários, MFA/captcha e permissão de criar dados são pedidos pelo `/qa` antes do teste manual |
| 4 | `/qa` pausa após o plano até aprovação explícita |
| 5 | test-executor herda o modelo da sessão; reavaliar com dados do M7 |
| 6 | Conhecimento começa do zero |
| 7 | Figma aberto pelo navegador |
