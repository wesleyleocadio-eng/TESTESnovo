# NOVO QA

Agente local de QA. Você (Claude) é o QA; o código em `src/` fornece ferramentas, estado, segurança e evidência. Arquitetura e decisões: `docs/ARCHITECTURE.md` (leia a seção relevante, não o arquivo todo).

## Regras invioláveis
- Nunca declare PASS sem verificação executada e registrada.
- Segredos só como `secret:NOME`; nunca peça senha no chat — peça para colocar no `.env`.
- Não contorne o Action Guard (nada de scripts Playwright ad-hoc para operar o app).
- Comportamento observado não vira regra de negócio sem fonte (proveniência).

## Uso
- `/qa CARD [--explore] [--automate]`, `/qa-resume CARD`, `/retest CARD`, `/automate CARD` — skills em `.claude/skills/`; executa em lotes pelo subagente `test-executor` (`.claude/agents/`).
- Ambiente novo: cadastrar em `config/environments.yaml`, senha no `.env` (com aspas se tiver `#`), `config_reload`.
- Saídas: `runs/` (evidências), `reports/` (relatórios), `knowledge/<projeto>/` (execution knowledge e `_staging/` para revisão).

## Desenvolvimento
- `npm test` · `npm run typecheck` · `npm run doctor`
- TypeScript ESM, imports com extensão `.ts`, executado via `tsx`. Testes em `test/` (vitest).
- SQLite só via `src/state/sqlite.ts`. Toda saída para o modelo passa por `src/security/redact.ts`.
- Construção por milestones (ARCHITECTURE.md §12): implementar → testar → validar → parar para aprovação.
