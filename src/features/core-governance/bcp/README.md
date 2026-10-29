# Governança — Continuidade operacional (BCP) (`bcp`)

## Objetivo
Continuidade operacional: registro e importação idempotente de operações manuais feitas durante contingência, por setor. Este módulo nasce no alicerce M9-D800 (esqueleto, permissões, liga/desliga e rota do livro); as regras entram em M9-D830 a M9-D834, e cada demanda dona atualiza este README no mesmo commit.

## Tabelas
- `governance.bcp_sectors` (M9-D830, migration 817): catálogo FECHADO dos seis setores (ATENDIMENTO/ATD, LOCACAO/LOC, FINANCEIRO/FIN, OBRAS/OBR, CORRESPONDENTE/COR, JURIDICO/JUR) com o arquivo do runbook. Igual para toda empresa (sem `company_id`), só leitura; RLS + FORCE.
- `governance.manual_operations` (M9-D831, migration 818): a operação feita no papel. `manual_reference` (`<PREFIXO>-<AAAA>-<nnnnn>`) é UNIQUE por empresa; guarda setor, ocorrência, ator, evidência (`people.files`), `intended_action`, `form_type`, `payload`, `correlation_ref`, `validation_errors` e `status` (RECORDED, IMPORTED, REJECTED, RECONCILED). RLS + FORCE.
- `governance.bcp_form_templates` (M9-D834, migration 833): o modelo dos 11 formulários contingenciais (`fields`, `payload_schema`, `intended_action` fixa pelo `form_type`). Catálogo do sistema, sem `company_id`, só leitura; RLS + FORCE.

Antes (alicerce): nenhuma tabela. O alicerce cria o schema `governance` e a função `governance.apply_tenant_rls(regclass)`, que toda tabela do módulo chama na sua migration (faixa 20260101000800 a 20260101000869 no bloco E) para ganhar RLS + FORCE RLS, política `tenant_isolation` e GRANT protegido por existência do role `nayara_runtime`. Colunas padrão: `id uuid`, `group_id`, `company_id`, `created_at`, `updated_at`.

### Runbooks
`NayaraOne--API/docs/runbooks/bcp/` (M9-D830): um por setor, com os 7 tópicos (quando acionar, quem, o que continua, passo a passo, proibido, registrar, encerrar e importar). O teste `m9d830.runbooks` confere os seis arquivos e a ordem dos tópicos.

### Vínculo usuário-setor
`bcp.sectors.js#userSectors(userId, tenant, transaction)`: o setor vem do NOME do papel ativo do usuário, pelo parâmetro `governanca.bcp.setor_por_papel`; o papel ADMIN pertence aos seis; sem papel mapeado, nenhum setor (403 `GOV_BCP_SECTOR_FORBIDDEN`). Usado por D831, D832, D834 e D904. O papel precisa ainda ter a permissão `governance:bcp:record` (a concessão padrão só a dá ao perfil Financeiro; o administrador distribui às demais).

### Formulários
Os 11 formulários vivem em `governance.bcp_form_templates` (M9-D834); `bcp.forms.constants.js` é só a origem da semente da migration 833 e `bcp.schema.js` gera `fields` e `payload_schema`. `formTemplates.repository.js` lê o modelo; `bcp.payload.js` valida o payload pelo `payload_schema` (tipo do campo em `x-bcpType`; valor em centavos só como inteiro). Impressão: `formPrint.service.js` (+ `.range.js`, `.render.js`) gera o PDF A4 em branco ou com folhas numeradas `<PREFIXO>-<AAAA>-<nnnnn>` (o mesmo número que a D831 aceita).

## Rotas e permissões
- `POST /bcp/manual-operations` (`governance:bcp:record`): grava `RECORDED` e publica o evento; nunca recusa por payload inválido (fica com `validation_errors`). Erros: 409 `GOV_BCP_REFERENCE_DUPLICATE`, 422 `GOV_BCP_REFERENCE_INVALID`, `GOV_BCP_EVIDENCE_REQUIRED`, `GOV_BCP_ACTION_INVALID`, `GOV_BCP_DATE_INVALID`, 403 `GOV_BCP_SECTOR_FORBIDDEN`.
- `PATCH /bcp/manual-operations/:id` (`governance:bcp:record`): corrige o payload de operação `RECORDED` (409 `GOV_BCP_NOT_EDITABLE`, 422 `GOV_BCP_PAYLOAD_INVALID`).
- `GET /bcp/manual-operations` (`governance:bcp:record` ou `governance:bcp:import`): filtros `status`, `sector`, `correlationRef`, `limit`, `offset`; só os setores do usuário.
- `GET /bcp/form-templates` (`governance:bcp:record` ou `governance:bcp:import`): modelos dos setores do usuário (`?sector=`).
- `GET /bcp/form-templates/:sector/:formType/print` (idem): PDF em branco, ou `?from=&to=&year=` para folhas numeradas (ano padrão = corrente em America/Sao_Paulo). 404 `GOV_BCP_FORM_NOT_FOUND`, 403 `GOV_BCP_SECTOR_FORBIDDEN`, 400 `GOV_BCP_RANGE_INVALID`.
- `GET /bcp` exige `governance:bcp:record` e o módulo ligado para a empresa (esqueleto do alicerce: devolve o estado do módulo). Sem login: 401 `MISSING_ACCESS_TOKEN`; sem permissão: 403 `PERMISSION_DENIED`; módulo desligado: 403 `GOV_MODULE_DISABLED`.
- Corpo de erro único: `{success:false,error:{code,message,details?,traceId}}` (traceId dentro de `error`).

## Eventos
- `bcp.manual_operation.recorded` (M9-D831): publicado na mesma transação do registro; `idempotencyKey = bcp.manual_operation.recorded:<empresa>:<manual_reference>` (DI-D831-2).
- `bcp.manual_operation.imported` (publicado pelo serviço do módulo via `publishGovernanceEvent`, na mesma transação, com `idempotencyKey`).

## Jobs e horários
Nenhum job no alicerce. Jobs deste módulo (se houver) são definidos pela demanda dona e listados aqui com horário e parâmetro que o controla.

## Parâmetros
- `governanca.modulos.bcp.habilitado` (booleano, padrão ligado): o administrador liga ou desliga o módulo para a empresa em Configurações > Governança.
- `governanca.bcp.setor_por_papel` (json em texto, M9-D830): perfis de cada setor. `governanca.bcp.listagem_limite` (inteiro, padrão 100, M9-D831): operações por página. `governanca.bcp.impressao_max_folhas` (inteiro, padrão 500, M9-D834): folhas numeradas por impressão.
- Demais parâmetros do módulo: acrescentados pela demanda dona em `governance.settings.js` e em `SETTINGS_SCHEMA`, sempre com padrão do catálogo (`Maturacao/demandas/parametros.csv`).

## Decisões (ADR)
- K5: corpo de erro único com `error.traceId`; K4: código novo com prefixo `GOV_` (lista fechada de exceções configurável em `governanca.erros.excecoes_prefixo_gov`).
- Padrão do projeto de deixar o administrador decidir: tudo que é regra alternativa, limite, prazo, canal ou liga/desliga vira parâmetro, nunca valor fixo no código.
- Decisões de implementação do bloco: `Maturacao/demandas/decisoes-de-implementacao.md`.

## Como testar
`node scripts/withDisposableDb.js --port <porta> -- ...` com `test/m9d800.alicerceGovernanca.test.js` (alicerce) e os testes da demanda dona. Nunca contra o banco do `.env`.

## Como diagnosticar
Use o `traceId` da resposta de erro (igual ao cabeçalho `X-Correlation-Id`) para achar a requisição nos logs e no registro de auditoria. Módulo respondendo 403 `GOV_MODULE_DISABLED`: conferir a chave `governanca.modulos.bcp.habilitado` em Configurações > Governança.
