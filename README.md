# NOVO QA

Agente local de QA que roda dentro do [Claude Code](https://claude.com/claude-code). O Claude atua como QA: lê o card do Jira, planeja os testes por risco, executa no navegador, investiga anomalias, classifica os resultados e gera o relatório com evidências. O código deste repositório oferece as ferramentas para isso (servidor MCP `novo-qa`), guarda o estado, aplica as regras de segurança e registra as evidências.

Tudo roda na sua máquina. Evidências, banco e relatórios ficam em pastas locais fora do git.

## O que ele faz

- **Testa um card:** lê o Jira (critérios de aceite e comentários relevantes), monta um plano por risco e **espera sua aprovação** antes de abrir o navegador.
- **Executa com verificação:** cada passo é conferido na tela, na rede, na API ou depois de recarregar a página. Sem verificação registrada, o cenário não pode ser marcado como PASSED.
- **Investiga antes de acusar bug:** olha rede, console e API, reproduz o problema e classifica o resultado (bug do produto, falha de ambiente, massa de dados, ambiguidade do requisito…).
- **Protege o ambiente:** o Action Guard bloqueia ações destrutivas (excluir, pagar…) sem aprovação humana, impede DELETE na rede e, em produção, só permite ações de leitura.
- **Gera evidências:** vídeo da sessão com capítulos por cenário, prints, respostas de erro da API e trace, tudo com senhas e tokens mascarados.
- **Gera o relatório:** `.md` e `.html`, com seção "Bugs explicados" em linguagem simples, e um rascunho de comentário para o Jira (não publicado).
- **Aprende com os testes:** grava os passos validados por módulo, para reutilizar nos próximos cards e na automação, e propõe regras para revisão humana.
- **Automatiza:** opcionalmente gera testes Playwright a partir do que foi executado e verificado manualmente.

## Requisitos

- Node.js 22.13 ou mais recente (testado no 24)
- Claude Code (CLI, desktop ou extensão do VS Code)
- Atlassian MCP conectado ao Claude Code, para ler os cards do Jira

## Instalação

```bash
npm install
npx playwright install chromium
cp .env.example .env
npm run doctor
```

O `.mcp.json` já registra o servidor `novo-qa`. Ao abrir o Claude Code na pasta do projeto, aprove o servidor quando ele pedir.

## Configurar um ambiente

1. Cadastre o ambiente em `config/environments.yaml`: URL, tipo (`dev`, `staging` ou `prod`), papéis e usuários, se pode criar dados.
2. Coloque as senhas **no `.env`**, nunca no YAML nem no chat. Use aspas se a senha tiver `#`:
   ```
   GURUJA_DEV_ALUNO_PASSWORD='minha#senha'
   ```
3. No Claude Code, rode a ferramenta `config_reload` (ou `npm run doctor`) para conferir se não falta nada.

O projeto do Jira é mapeado em `config/projects.yaml`, e as regras de evidência e de risco ficam em `config/qa-policy.yaml`.

## Uso

No Claude Code, dentro da pasta do projeto:

| Comando | O que faz |
|---|---|
| `/qa CARD-123` | Testa o card: descoberta, plano (para aprovação), execução, relatório |
| `/qa CARD-123 --explore` | O mesmo, com mais testes exploratórios |
| `/qa CARD-123 --automate` | Ao final, gera e valida automação Playwright |
| `/qa-resume CARD-123` | Retoma um teste interrompido sem refazer o que já terminou |
| `/retest CARD-123` | Reteste após correção: refaz o que falhou e compara com o anterior |
| `/automate CARD-123` | Gera a automação de um teste manual já concluído |

Durante o teste, o Claude pede sua confirmação para ações destrutivas, como excluir ou remover. Ele não aprova essas ações sozinho.

## Onde ficam os resultados

| Pasta | Conteúdo |
|---|---|
| `reports/<card>/` | Relatório `.md` e `.html` de cada execução |
| `runs/<card>/<execução>/` | Evidências: vídeos, prints, traces, respostas de erro |
| `knowledge/<projeto>/execution/` | Passos validados por módulo (versionado) |
| `knowledge/<projeto>/_staging/` | Regras e comportamentos propostos, aguardando revisão humana |
| `data/novo-qa.db` | Estado das execuções (SQLite) |

`runs/`, `reports/`, `data/` e `.env` estão no `.gitignore`, porque podem conter dados sensíveis.

## Regras que o código garante

- PASSED só com verificação executada e registrada pela ferramenta. Se a verificação falha, o print vira evidência automaticamente.
- A confiança do resultado é calculada por regras fixas, não pela opinião do modelo.
- Segredos só como referência (`secret:NOME` ou papel do ambiente), e toda saída é sanitizada antes de chegar ao modelo e aos arquivos.
- Operar o app só pelas ferramentas do `novo-qa`. Um hook bloqueia scripts que controlam o navegador por fora do Action Guard.
- Comportamento observado não vira regra de negócio sem fonte documental.

## Desenvolvimento

```bash
npm test            # vitest
npm run typecheck   # tsc --noEmit
npm run doctor      # checagem de ambiente e configuração
npm run fixture     # app de exemplo local (porta 4400) para testar as ferramentas
```

TypeScript ESM executado via `tsx`, com imports usando a extensão `.ts`. Acesso ao SQLite só por `src/state/sqlite.ts`.

```text
src/
  mcp/         servidor MCP e ferramentas (estado, navegador, contexto, QA, automação)
  browser/     sessão Playwright, observadores de rede/console, snapshot
  guard/       Action Guard
  security/    segredos, sanitização, traces
  state/       SQLite, regras de status e confiança, limpeza de dados
  sources/     cache de digests (Jira)
  context/     pacote de contexto do card
  knowledge/   execution knowledge e propostas para revisão
  reporting/   relatório .md e .html
  metrics/     uso de tokens e tempo a partir dos transcripts
  automation/  avaliação, spec e execução da automação
.claude/
  skills/      /qa, /qa-resume, /retest, /automate
  agents/      test-executor (executa os cenários em lotes)
  hooks/       guard-shell (bloqueia operação do navegador por fora do MCP)
config/        ambientes, projetos e política de QA
test/          testes (vitest) e app fixture
```

Decisões de design, fluxo completo e ferramentas MCP: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
