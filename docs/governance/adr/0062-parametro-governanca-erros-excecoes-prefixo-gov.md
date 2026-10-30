# ADR 0062 — Parâmetro governanca.erros.excecoes_prefixo_gov

## Contexto
O livro não fixa o valor deste ponto (M9-D800 (K4: códigos da plataforma mantidos para não quebrar os clientes atuais)). Pela regra do Patrick, o que o livro não resolve vira parâmetro de configuração com padrão explícito (catálogo P9-EF-085).

## Decisão
Parâmetro `governanca.erros.excecoes_prefixo_gov`, padrão: PERMISSION_DENIED, MISSING_ACCESS_TOKEN, MFA_STEP_UP_REQUIRED, MFA_REQUIRED_NOT_ENABLED, INTERNAL_ERROR, VALIDATION_ERROR. Origem: M9-D800 (K4: códigos da plataforma mantidos para não quebrar os clientes atuais). O administrador altera em /painel/configuracoes (aba correspondente) e o código lê sempre por `getSetting`, nunca valor fixo.

## Alternativas
Valor fixo no código. Rejeitada: o livro não o determina e a regra do Patrick manda configurar. Obrigação rígida além do livro. Rejeitada pelo mesmo motivo; o padrão adotado é o mais conservador ou o do livro.

## Consequências
A mudança vale na leitura seguinte, fica auditada pelo registro de configuração e consta no README do módulo dono e em `Maturacao/demandas/parametros.csv`.

## Data
2026-10-27

## Responsável
Patrick (dono do projeto), pela regra de que o livro manda e o que o livro não resolve vira decisão registrada.
