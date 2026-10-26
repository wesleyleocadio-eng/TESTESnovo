---
name: qa-resume
description: Retoma um run de QA interrompido do NOVO QA a partir do estado salvo, sem refazer cenários concluídos. Uso: /qa-resume CARD-123 (o /resume nativo do Claude Code retoma conversas, não runs)
argument-hint: CARD-123
---

# /qa-resume — retomar um run

Argumentos: $ARGUMENTS (card ou runId). Fale com o usuário em português.

O estado está no SQLite, não no seu contexto: confie nas ferramentas, não em memória de conversa anterior.

1. `run_status(card)`. Sem run ou run já COMPLETED/ABORTED → diga isso e sugira `/qa` (novo) ou `/retest` (após correção). Pare.
2. Mostre ao usuário o progresso (ex.: "19/32 concluídos; próximo: CT-020") e o que estava em andamento.
3. Conforme o status do run:
   - **PLANNING** — o plano não foi salvo. Retome o `/qa` a partir do planejamento (`.claude/skills/qa/SKILL.md`, seções 1–3; o digest e o Context Package estão em cache).
   - **AWAITING_APPROVAL** — `plan_view(card)`, reapresente o plano e espere aprovação explícita → `plan_approve`.
   - **EXECUTING** — o navegador pode ter sido fechado: o executor reabre (`browser_open`) e reaproveita a sessão salva do papel. Siga `.claude/skills/qa/references/execute-and-close.md`. Cenários concluídos não são reexecutados; o cenário interrompido vem com `resume` no briefing (o que já foi verificado).
4. Se o card mudou desde o plano (`getJiraIssue(fields=["updated"])` ≠ `digestVersion` do `context_build`), avise o usuário antes de continuar: pode valer abortar (`run_abort`) e replanejar.
