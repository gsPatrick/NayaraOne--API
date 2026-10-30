# migration-v2 — migração do sistema antigo (Marco 9, bloco GOV)

Feature fora das oito pastas de `core-governance`: a migração tem ciclo de vida próprio (ensaios DRY1 a DRY3 e o corte). Tabelas no schema `governance` (RLS FORCE por empresa de destino) e `core.external_refs`.

## Responsabilidades

| Arquivo | O que faz |
|---|---|
| `externalRefs.service.js` | M9-D906. `register` (idempotente), `lookup(sistema, chave, data, {entityType})`, `closeRef`, `repoint` (gancho do merge da M9-D805) e `remove` (sempre `GOV_EXTREF_IMMUTABLE`). Tabela `core.external_refs`: gatilho barra DELETE e qualquer mudança além de encerrar a vigência. |
| `ingest/executor.js` | M9-D900. Executa uma execução QUEUED: uma fonte por vez, um lote por vez, até esgotar a leitura. |
| `ingest/cdc.reader.js`, `watermark.reader.js`, `fulldiff.reader.js` | Planejam o próximo lote de cada modo (CDC por posição, WATERMARK por `(updated_at, chave)` com sobreposição, FULL_DIFF por hash da linha). |
| `ingest/connectors/` | Quem lê o legado. `SQL` (somente leitura; o endereço sai da variável de ambiente nomeada em `secret_ref`) e registro de outros conectores por nome. |
| `ingest/applier.js`, `applier.event.js` | Aplica o lote numa transação: idempotência por `<sistema>:<entidade>:<chave>:<posição>`, regras de delta, quarentena, exclusão lógica, checkpoint, resumo e auditoria `migration.batch.applied`. |
| `ingest/batch.runner.js`, `batch.states.js`, `batch.repository.js` | Ciclo do lote (K8): RUNNING numa transação própria, tentativas, ABORTED, um lote RUNNING por fonte. |
| `ingest/replay.js`, `deletions.js` | Replay como novo lote (`replay_of`); comparação de chaves que marca `source_deleted`. |
| `ingest/targets/` | Destino por entidade (`PERSON`, `SUPPLIER`, `PROPERTY`): `assess` (quarentena ou revisão), `upsert`, `markDeleted`. Entidade nova = um arquivo + uma linha em `targets/index.js` + uma semente. |
| `seeds/sources.seed.js` | Fontes semeadas por empresa (sem rota de cadastro). |
| `migration.routes.js` | `POST /migration/runs` (permissão `governance:migration:run`) responde 202 com `{runId}`; `GET /migration/raci` (run) e `PUT /migration/raci` (`governance:migration:admin`). |
| `raci/` | M9-D902. RACI de cutover: dez atividades semeadas por empresa (`raci.seed`), matriz por atividade com exatamente um A e ao menos um R (`raci.service`, 422 `GOV_RACI_SINGLE_ACCOUNTABLE` para o segundo A; matriz sem A ou sem R é aceita e vira o blocker `GOV_MIG_RACI_INCOMPLETE` da Torre), papel do ator por usuário ou perfil (`raci.access`). A atividade `LAST_DELTA_LOAD` dispara `POST /migration/runs` com `lastDelta: true`. |

## Parâmetros (aba Governança em /painel/configuracoes)

| Chave | Padrão | Lido por |
|---|---|---|
| `migracao.lote.tamanho` | 2000 | `batch.runner.loadSettings` (tamanho de cada lote) |
| `migracao.watermark.sobreposicao_s` | 120 | `watermark.reader.startCursor` via executor |
| `migracao.lote.max_tentativas` | 3 | `batch.runner.runBatch` (falhas seguidas até ABORTED) |
| `migracao.lote.timeout_min` | 30 | `batch.runner.releaseStale` (lote RUNNING sem fim vira FAILED) |

## Operação

- Variável de ambiente `MIGRATION_LEGACY_DB_URL`: endereço somente leitura da área `legado` (nunca em arquivo versionado).
- `MIGRATION_RUN_JOB_DISABLED=true` desliga o job que retoma execuções QUEUED.
- Replay: `replay.replayBatch(tenant, actor, batchId)`.
