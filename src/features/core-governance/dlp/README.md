# Governança — Proteção contra vazamento (DLP) (`dlp`)

## Objetivo
Proteção contra vazamento: classificação, política de exportação, máscara e bloqueio (exportação RESTRICTED sem MFA bloqueia). Este módulo nasce no alicerce M9-D800 (esqueleto, permissões, liga/desliga e rota do livro); as regras entram em M9-D820 a M9-D825, e cada demanda dona atualiza este README no mesmo commit.

## Tabelas
- `governance.dlp_policies` (M9-D820, migration 20260101000820): a política da empresa, uma linha por (classificação, ação) = 4 x 6 = 24 linhas (`allowed`, `require_permission`, `require_justification`, `require_mfa`, `require_audit`, `require_watermark`, `require_mask`, `max_rows`, `max_expiry_hours`, `updated_by`). As linhas nascem na primeira leitura (matriz padrão + parâmetros `governanca.dlp.*`). RLS + FORCE por `company_id`.

Demais tabelas: ainda nenhuma. O alicerce cria o schema `governance` e a função `governance.apply_tenant_rls(regclass)`, que toda tabela do módulo chama na sua migration (faixa 20260101000800 a 20260101000869 no bloco E) para ganhar RLS + FORCE RLS, política `tenant_isolation` e GRANT protegido por existência do role `nayara_runtime`. Colunas padrão: `id uuid`, `group_id`, `company_id`, `created_at`, `updated_at`.

## Rotas e permissões
- `GET /dlp` exige `governance:dlp:admin` e o módulo ligado para a empresa (esqueleto do alicerce: devolve o estado do módulo). Sem login: 401 `MISSING_ACCESS_TOKEN`; sem permissão: 403 `PERMISSION_DENIED`; módulo desligado: 403 `GOV_MODULE_DISABLED`.
- `GET /dlp/policies` (`governance:dlp:export` ou `governance:dlp:admin`) devolve as 24 linhas; `PUT /dlp/policies/:classification/:action` (`governance:dlp:admin`) altera só os campos enviados, recusa enfraquecer o piso do livro (EXPORT de HIGH/RESTRICTED sem justificativa, MFA, auditoria ou expiração: 422 `GOV_DLP_FLOOR_VIOLATION`), valida (400 `GOV_DLP_POLICY_INVALID`) e audita `governance.dlp_policy.changed` com antes e depois. Mesmo conteúdo: nada muda, nada é auditado.
- Corpo de erro único: `{success:false,error:{code,message,details?,traceId}}` (traceId dentro de `error`).

## Eventos
- `dlp.export.blocked` (publicado pelo serviço do módulo via `publishGovernanceEvent`, na mesma transação, com `idempotencyKey`).

## Jobs e horários
Nenhum job no alicerce. Jobs deste módulo (se houver) são definidos pela demanda dona e listados aqui com horário e parâmetro que o controla.

## Parâmetros
- `governanca.modulos.dlp.habilitado` (booleano, padrão ligado): o administrador liga ou desliga o módulo para a empresa em Configurações > Governança.
- `governanca.dlp.classificacao_padrao`, `volume_teto_por_classe`, `expiracao_horas_da_classe` (o único parâmetro de prazo), `watermark.padrao_por_classe`, `finalidades` e `justificativa_min`: política inicial e catálogo da D821 (aba Governança, grupo "Proteção contra vazamento (DLP)").
- Demais parâmetros do módulo: acrescentados pela demanda dona em `governance.settings.js` e em `SETTINGS_SCHEMA`, sempre com padrão do catálogo (`Maturacao/demandas/parametros.csv`).

## Decisões (ADR)
- K5: corpo de erro único com `error.traceId`; K4: código novo com prefixo `GOV_` (lista fechada de exceções configurável em `governanca.erros.excecoes_prefixo_gov`).
- Padrão do projeto de deixar o administrador decidir: tudo que é regra alternativa, limite, prazo, canal ou liga/desliga vira parâmetro, nunca valor fixo no código.
- Decisões de implementação do bloco: `Maturacao/demandas/decisoes-de-implementacao.md`.

## Como testar
`node scripts/withDisposableDb.js --port <porta> -- ...` com `test/m9d800.alicerceGovernanca.test.js` (alicerce) e os testes da demanda dona. Nunca contra o banco do `.env`.

## Como diagnosticar
Use o `traceId` da resposta de erro (igual ao cabeçalho `X-Correlation-Id`) para achar a requisição nos logs e no registro de auditoria. Módulo respondendo 403 `GOV_MODULE_DISABLED`: conferir a chave `governanca.modulos.dlp.habilitado` em Configurações > Governança.
