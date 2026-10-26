---
name: retest
description: Reteste de um card no NOVO QA após correção — reexecuta o que não passou no último run concluído, mais vizinhos de risco, e compara com o resultado anterior. Uso: /retest CARD-123
argument-hint: CARD-123
---

# /retest — reteste após correção

Argumentos: $ARGUMENTS (card). Fale com o usuário em português.

1. `run_status(card)`. Run ativo → ofereça `/qa-resume`. Pare.
2. **O que mudou:** `getJiraIssue(card, fields=["updated"])` → `digest_get`. Mudou: releia o card e atualize o digest — no reteste os comentários novos importam (o que o dev corrigiu, em qual ambiente, como reproduzir). Leia os bugs abertos no ciclo anterior se estiverem linkados (mesmo fluxo de digest). `context_build(card)`: o `history` mostra o run anterior e o que não passou.
3. `run_start(card, env, mode: "retest", parentRunId)` com o último run COMPLETED do card (do `history`). Ambiente diferente do anterior só se o usuário pedir ou o comentário do dev indicar.
4. `retest_seed(runId)`: cenários que não passaram, com o que foi observado, e a lista dos que passaram.
5. Monte o plano (`plan_save`, mesmos `modules` do pai):
   - Todos os que **não passaram**, com os **mesmos códigos**. Ajuste passos/pré-condições se o dev indicou outro caminho (ex.: outro ponto de entrada). BLOCKED por massa/ambiente: inclua só se a causa foi resolvida; senão mantenha e diga por quê.
   - **Vizinhos de risco** entre os que passaram: o que compartilha tela, componente, endpoint ou regra com a correção. Poucos e justificados.
   - Cenário novo só se a correção criou comportamento novo; use `nextCode`.
6. Mostre ao usuário: o que será retestado e por quê, vizinhos escolhidos, o que fica de fora. **Espere aprovação** → `plan_approve`.
7. Siga `.claude/skills/qa/references/execute-and-close.md`. Na classificação, compare com o `before` de cada cenário: falha que some ao trocar de ambiente/versão confirma ENVIRONMENT_FAILURE no ciclo anterior — diga isso no resumo. O relatório traz a comparação (corrigidos, ainda falham, regressões).
