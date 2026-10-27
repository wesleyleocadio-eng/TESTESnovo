# Execução, limpeza, aprendizado e fechamento

Vale para /qa, /qa-resume e /retest, com o plano já aprovado (run EXECUTING).

## Execução em lotes
Repita até `batch_brief` voltar vazio:
1. `batch_brief(runId)`.
2. Delegue o lote ao subagente `test-executor` com: `runId`, os códigos do lote e qualquer orientação que só você tem (ex.: "dev pediu para abrir pelo card do professor na barra lateral"). Não copie o briefing: ele chama `batch_brief`. Cenário com `resume` no briefing continua de onde parou.
3. Leia o resumo devolvido. Anomalia sem explicação → decida se vira exploratório (`scenario_add`) no próximo lote. Pedido de aprovação RED → pergunte ao usuário antes de mandar seguir.

Com `--explore`, reserve um lote para exploração dirigida pelos riscos mais altos.

## Limpeza
`cleanup_run(runId)`. Itens `unregistered` → `data_register` (api/manual com `verify`, ou `keep` com motivo). Repita até tudo VERIFIED ou KEPT.

## Aprendizado
`knowledge_propose` só com o que vale para o próximo card do módulo: regras com fonte documental, comportamentos observados (OBSERVED), riscos, regressões. Bug nunca vira regra.

## Fechamento
Recomendação: REPROVADO se houver PRODUCT_BUG em P0/P1 ou critério de aceite violado; INCONCLUSIVO se P0/P1 BLOCKED/NEEDS_REVIEW; senão APROVADO. `run_complete(runId, recommendation, summary)` → `report_build(runId, explanations)`, com um item por problema (FAILED e divergências relevantes) em linguagem simples para quem não acompanhou: onde clicar para ver, o que acontece, o que o card pede e ressalvas (ex.: verificação reprovada que foi erro de automação, dúvida para o PO). Mostre o resumo, os caminhos do relatório (`.md` e `.html`) e as dúvidas para o PO, e abra o HTML no navegador do usuário (Windows: `start "" "<caminho do .html>"`; macOS: `open`; Linux: `xdg-open`). Comentar no Jira só se o usuário pedir (o rascunho está no relatório).
