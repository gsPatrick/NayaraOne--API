# Governança — Continuidade operacional (BCP) (`bcp`)

## Objetivo
Continuidade operacional: registro e importação idempotente de operações manuais feitas durante contingência, por setor. Este módulo nasce no alicerce M9-D800 (esqueleto, permissões, liga/desliga e rota do livro); as regras entram em M9-D830 a M9-D834, e cada demanda dona atualiza este README no mesmo commit.

## Tabelas
- `governance.bcp_sectors` (M9-D830, migration 817): catálogo FECHADO dos seis setores (ATENDIMENTO/ATD, LOCACAO/LOC, FINANCEIRO/FIN, OBRAS/OBR, CORRESPONDENTE/COR, JURIDICO/JUR) com o arquivo do runbook. Igual para toda empresa (sem `company_id`), só leitura; RLS + FORCE.

Antes (alicerce): nenhuma tabela. O alicerce cria o schema `governance` e a função `governance.apply_tenant_rls(regclass)`, que toda tabela do módulo chama na sua migration (faixa 20260101000800 a 20260101000869 no bloco E) para ganhar RLS + FORCE RLS, política `tenant_isolation` e GRANT protegido por existência do role `nayara_runtime`. Colunas padrão: `id uuid`, `group_id`, `company_id`, `created_at`, `updated_at`.

### Runbooks
`NayaraOne--API/docs/runbooks/bcp/` (M9-D830): um por setor, com os 7 tópicos (quando acionar, quem, o que continua, passo a passo, proibido, registrar, encerrar e importar). O teste `m9d830.runbooks` confere os seis arquivos e a ordem dos tópicos.

### Vínculo usuário-setor
`bcp.sectors.js#userSectors(userId, tenant, transaction)`: o setor vem do NOME do papel ativo do usuário, pelo parâmetro `governanca.bcp.setor_por_papel`; o papel ADMIN pertence aos seis; sem papel mapeado, nenhum setor (403 `GOV_BCP_SECTOR_FORBIDDEN`). Usado por D831, D832, D834 e D904. O papel precisa ainda ter a permissão `governance:bcp:record` (a concessão padrão só a dá ao perfil Financeiro; o administrador distribui às demais).

## Rotas e permissões
- `GET /bcp` exige `governance:bcp:record` e o módulo ligado para a empresa (esqueleto do alicerce: devolve o estado do módulo). Sem login: 401 `MISSING_ACCESS_TOKEN`; sem permissão: 403 `PERMISSION_DENIED`; módulo desligado: 403 `GOV_MODULE_DISABLED`.
- Corpo de erro único: `{success:false,error:{code,message,details?,traceId}}` (traceId dentro de `error`).

## Eventos
- `bcp.manual_operation.recorded` (publicado pela M9-D831 sobre o serviço do módulo).
- `bcp.manual_operation.imported` (publicado pelo serviço do módulo via `publishGovernanceEvent`, na mesma transação, com `idempotencyKey`).

## Jobs e horários
Nenhum job no alicerce. Jobs deste módulo (se houver) são definidos pela demanda dona e listados aqui com horário e parâmetro que o controla.

## Parâmetros
- `governanca.modulos.bcp.habilitado` (booleano, padrão ligado): o administrador liga ou desliga o módulo para a empresa em Configurações > Governança.
- `governanca.bcp.setor_por_papel` (json em texto, M9-D830): perfis de cada setor.
- Demais parâmetros do módulo: acrescentados pela demanda dona em `governance.settings.js` e em `SETTINGS_SCHEMA`, sempre com padrão do catálogo (`Maturacao/demandas/parametros.csv`).

## Decisões (ADR)
- K5: corpo de erro único com `error.traceId`; K4: código novo com prefixo `GOV_` (lista fechada de exceções configurável em `governanca.erros.excecoes_prefixo_gov`).
- Padrão do projeto de deixar o administrador decidir: tudo que é regra alternativa, limite, prazo, canal ou liga/desliga vira parâmetro, nunca valor fixo no código.
- Decisões de implementação do bloco: `Maturacao/demandas/decisoes-de-implementacao.md`.

## Como testar
`node scripts/withDisposableDb.js --port <porta> -- ...` com `test/m9d800.alicerceGovernanca.test.js` (alicerce) e os testes da demanda dona. Nunca contra o banco do `.env`.

## Como diagnosticar
Use o `traceId` da resposta de erro (igual ao cabeçalho `X-Correlation-Id`) para achar a requisição nos logs e no registro de auditoria. Módulo respondendo 403 `GOV_MODULE_DISABLED`: conferir a chave `governanca.modulos.bcp.habilitado` em Configurações > Governança.
