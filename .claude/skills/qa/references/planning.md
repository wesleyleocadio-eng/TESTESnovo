# Planejamento por risco

## Risco
Para cada área tocada pelo card, avalie impacto (dinheiro, dados, permissão, quantos usuários) e probabilidade (código novo, integração, histórico de bug no módulo, ambiguidade do card). Risco = HIGH / MEDIUM / LOW. Profundidade segue o risco: HIGH ganha negativos, bordas e permissão; LOW pode ser um caminho feliz.

Considere sempre: permissões por papel, dados ausentes/vazios/longos, integração e contrato de API, persistência (recarregar, reabrir), regressão no que já existia, segurança funcional (ver/alterar o que não é seu).

## Cenários
- Um comportamento verificável por cenário. Código `CT-001`, `CT-002`… em ordem de execução: dependências primeiro, depois P0 → P3.
- Cada critério de aceite coberto por pelo menos um cenário; cite o CA no título ou no `expected`.
- `expected` observável e verificável por ferramenta: texto/estado na tela, URL, request e status, dado persistido. Nunca "funciona corretamente".
- `steps` curtos, no nível do usuário. `preconditions` diz massa e papel.
- `types`: functional, negative, permission, validation, visual, regression, exploratory.
- Prioridade: P0 bloqueia a entrega (CA principal, perda de dado, permissão); P1 CA secundário; P2 borda relevante; P3 cosmético.
- Visual contra Figma só quando o card pede aderência visual: um cenário dedicado, executado com screenshot.

## O que não planejar
- O que o card põe fora de escopo.
- Reteste de algo já coberto, salvo regressão de risco.
- Cenário que exige ação RED sem necessidade (se for indispensável, deixe explícito no plano: vai pedir aprovação).

## Premissas e dúvidas
Ambiguidade do card vira premissa explícita no plano e cenário que **registra** o comportamento (NEEDS_REVIEW se não houver base para julgar). Não invente regra.

## Módulos
`modules` do `plan_save`: o módulo principal primeiro (recebe o execution knowledge). Use os nomes de `knowledge.modulesAvailable` quando casarem; senão crie um nome curto em kebab-case.
