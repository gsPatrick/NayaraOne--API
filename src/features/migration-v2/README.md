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
| `migration.routes.js` | `GET /migration/control-tower?runId=` e `POST /migration/records/:id/resolve` (ambas `governance:migration:run`); `POST /migration/runs` (permissão `governance:migration:run`) responde 202 com `{runId}`; `GET /migration/raci` (run) e `PUT /migration/raci` (`governance:migration:admin`). |
| `control/` | M9-D901. Torre de controle: `tower.service` (contadores total/migrated/reconciled/quarantined/pending_review/excluded/not_started no total e por entidade, blockers, ETA), `counters.*` (contadores materializados por gatilho + conferência), `blockers.*` (regras, gravação com `since`, abertura e fechamento auditados, `blockers.providers` para D903, D907 e D908), `eta.service` (vazão dos últimos lotes), `record.states` e `record.transition` (máquina de estados do registro), `resolve.service` e `resolve.apply` (decisão humana com RACI e aplicador da D900). |
| `ingest/pending.processor.js` | Processa os registros PENDING (decisão REPROCESS) no próximo lote do aplicador, sem mexer no checkpoint. |
| `integrity/` | M9-D905. Integridade do lote: `canonical` (linha canônica: comprimento em bytes, nulo 0x00, separador 0x1F), `merkle` (folha 0x00, nó 0x01, ímpar sobe sem duplicar, chaves em ordem binária), `schema.*` (esquema por entidade, `GOV_MIG_SCHEMA_MISSING`), `leaves.repository` (folhas), `batch.verify` (raiz do destino relida do banco contra a da origem e as contagens: VERIFIED ou HASH_MISMATCH), `reconcile` (VERIFIED leva MIGRATED a RECONCILED; HASH_MISMATCH leva só as linhas divergentes à quarentena), `verify.job` (lotes APPLIED, cada um na sua transação). `ingest/batch.hash.js` calcula a raiz Merkle da origem na aplicação. |
| `raci/` | M9-D902. RACI de cutover: dez atividades semeadas por empresa (`raci.seed`), matriz por atividade com exatamente um A e ao menos um R (`raci.service`, 422 `GOV_RACI_SINGLE_ACCOUNTABLE` para o segundo A; matriz sem A ou sem R é aceita e vira o blocker `GOV_MIG_RACI_INCOMPLETE` da Torre), papel do ator por usuário ou perfil (`raci.access`). A atividade `LAST_DELTA_LOAD` dispara `POST /migration/runs` com `lastDelta: true`. |
| `parallel/` | M9-D903. Comparação paralela antigo x novo: `window.service` (cria a janela e valida que todo campo mapeado tem regra), `window.input`, `time.local` (datas sem fuso lidas no fuso configurado), `compare.rule` e `compare.normalize` (EXACT, MONEY em centavos com tolerância 0, DATE por dia civil, NUMERIC com tolerância por campo, ENUM_MAP, IGNORE; hash HMAC do valor normalizado), `comparator` (pareia pelo ID legado de `core.external_refs`, lê a origem pelo conector e o destino pelo `readCanonical` do alvo), `runner` (uma volta: reserva, compara, grava; execução que não termina vira FAILED), `blockers.provider` (blockers da Torre: um por diferença bloqueante em aberto), `report.service` (GET da janela com o claro recalculado na hora), `parallel.job` e `src/engines/jobs/parallelCompareJob.js` (a cada minuto). Rotas `POST /migration/parallel/windows` e `GET /migration/parallel/windows/:id` (`governance:migration:run`). |
| `canary/` | M9-D904. Ativação por setor (canary): `canary.service` (`advance`, `rollback`, `status`), `canary.steps` (etapa pedida: a próxima, a atual sem efeito ou 422), `canary.selection` (usuários pela ordem do SHA-256 do id, teto de N x percentual / 100), `canary.members` (usuários do setor pela função única `userSectors`), `canary.flag` (a entrada `migracao.setor.<setor>.novo_sistema`, tipo CONFIG INTEGER, escopo SECTOR, risco CRITICAL, é a ÚNICA fonte do estado; trava do setor por advisory lock), `canary.gate` (zero blockers da Torre cujo `entity` está em `migracao.setor.<setor>.entidades`) e `canary.comparison` (última comparação paralela da D903 concluída e sem DIFF_BLOCKER), `canary.impact` (provedor da linha 15 do inventário de ações destrutivas), `canary.hooks` (gancho do rollback para a M9-D907), `canary.login` (percentual resolvido por `flags.resolve` no login; o login devolve `migration: { newSystem, sectors }`). Rotas `GET /migration/canary`, `POST /migration/canary/:sector/advance|rollback` e `GET /migration/canary/:sector/impact`: exigem `governance:migration:run` E `governance:flags:manage`; o rollback exige ainda MFA recente, motivo, código do setor digitado e impacto. |
| `clock/` | M9-D908 §3.1. Validação de relógio: `clock.readers` (aplicação = referência; banco `SELECT now()`; fonte antiga por `readClock()` do conector; `ntp.reader` SNTP registrado só no processo da API), `clock.service` (`check`: deriva = maior diferença entre relógios; OK, DRIFT ou UNMEASURED; grava `governance.mig_clock_checks`), `clock.gate` (antes de cada lote; erro `GOV_MIG_CLOCK_DRIFT` 409 pausa o aplicador, o executor marca a execução PAUSED), `clock.blockers` (blocker da Torre pela conferência mais recente), `clock.resume` (a cada `migracao.relogio.reverificar_min` reconfere e devolve PAUSED a QUEUED) e o job `migrationClockJob`. |
| `timezone/` | M9-D908 §3.2. `timezone.convert` (horário local para UTC pela base IANA: OK, NONEXISTENT, AMBIGUOUS), `timezone.normalize` (por tipo do esquema da D905: `date` fica no dia civil, `instant` vai a UTC; quarentena `GOV_MIG_TZ_NONEXISTENT_LOCAL_TIME` / `GOV_MIG_TZ_AMBIGUOUS_LOCAL_TIME`), `timezone.context` (esquema e regras lidos uma vez por lote, usado por `ingest/applier.event`) e `timezone.sample` (amostra de datas de borda comparada ponto a ponto com a origem). |
| `dryrun/` | M9-D908 §3.3. Ensaio DRY3: `dry.service` (`openDryRun`, `executeDryRun`, `getReport`), `dry.orchestrator` (fases CLOCK, LOAD, DELTA, VERIFY, VOLUME, TZ_SAMPLE, COMPARE, ROLLBACK, TOWER e a conclusão pelos seis critérios de `dry.criteria`), `dry.guard` (só em banco descartável, `GOV_MIG_DRY_SHARED_DB`), `dry.volume` (contagem origem x destino, `GOV_MIG_VOLUME_MISMATCH`), `dry.compare` (janela curta da D903), `dry.rollback` (ativação e volta a 0 de cada setor, D904 e D907), `dry.display` (exemplos mascarados pela D915), `dry.export` (`docs/governance/dry3-report.json`), `dry.readiness` (o GO exige a simulação, `rollback/readiness.register`) e `dry.controller`. Rotas `POST /migration/dry-runs` (202) e `GET /migration/dry-runs/:id/report`, ambas `governance:migration:run`. |
| `alerts/window.overdue.js` | M9-D908 §3.5. Janela de comparação RUNNING além de `migracao.paralelo.prazo_dias` avisa (CRÍTICO) o A de `PARALLEL_COMPARE_CLOSE`, uma vez por janela e por dia (`governance.mig_alert_log`); roda no fim de cada volta do job da comparação. |

## Parâmetros (aba Governança em /painel/configuracoes)

| Chave | Padrão | Lido por |
|---|---|---|
| `migracao.lote.tamanho` | 2000 | `batch.runner.loadSettings` (tamanho de cada lote) |
| `migracao.watermark.sobreposicao_s` | 120 | `watermark.reader.startCursor` via executor |
| `migracao.lote.max_tentativas` | 3 | `batch.runner.runBatch` (falhas seguidas até ABORTED) |
| `migracao.lote.timeout_min` | 30 | `batch.runner.releaseStale` (lote RUNNING sem fim vira FAILED) |
| `migracao.eta.janela_lotes` | 5 | `control/eta.service` (quantos lotes entram na vazão do ETA) |
| `migracao.paralelo.intervalo_min` | 60 | `parallel/window.service` (intervalo padrão de uma janela criada sem `intervalMin`) |
| `migracao.paralelo.fuso` | America/Sao_Paulo | `parallel/window.service` (datas da janela sem fuso) e `parallel/runner` (regra DATE) |
| `migracao.paralelo.timeout_min` | 30 | `parallel/runner.reserve` (execução RUNNING sem fim vira FAILED) |
| `migracao.canary.etapas` | 5,25,50,100 | `canary/canary.params.readStages` (etapas do avanço) |
| `migracao.canary.exigir_comparacao` | ligado | `canary/canary.params.readRequireComparison` (comparação paralela obrigatória por entidade migrável) |
| `migracao.setor.<setor>.entidades` (seis chaves) | ver `canary/canary.settings.js` | `canary/canary.params.readEntities` (a quais entidades os blockers da Torre pertencem ao setor) |
| `migracao.rollback.itens_por_pagina` | 100 | `rollback/report.service.getReport` (operações listadas por página ao abrir um tipo) |
| `migracao.relogio.deriva_max_s` | 2 | `clock/clock.service.check` (limite da deriva entre relógios, em segundos) |
| `migracao.relogio.reverificar_min` | 5 | `clock/clock.resume.recheckAndResume` (intervalo da reverificação com a carga pausada) |
| `migracao.relogio.ntp_ativo` / `ntp_servidor` / `ntp_timeout_ms` | ligado / pool.ntp.org / 3000 | `clock/ntp.reader.readNtp` |
| `migracao.fuso_origem` / `migracao.fuso.ambiguo` | America/Sao_Paulo / FIRST_OCCURRENCE | `timezone/timezone.context` (usado por `ingest/applier.event` e pela amostra do ensaio) |
| `migracao.fuso.amostra_por_entidade` | 1000 | `dryrun/dry.orchestrator.sampleAll` |
| `migracao.paralelo.prazo_dias` | 7 | `alerts/window.overdue.alertOverdueWindows` |
| `migracao.dry3.janela_comparacao_min` / `exemplos_no_relatorio` / `dados_pessoais_em_claro` / `timeout_min` | 10 / 10 / desligado / 720 | `dryrun/dry.compare`, `dry.display`, `dry.service.openDryRun` |

## Plano para operações externas no rollback (M9-D907)

- `rollback/`: inventário (`governance.external_op_types`, semeado por empresa), decisão do GO (`governance.cutover_decisions`; T0 = a última decisão GO), registro (`governance.external_op_log`, gravado por `createDispatch` na mesma transação do envio) e itens (`governance.rollback_items`, criados pelo gancho `external-ops` do rollback de setor da D904).
- Rotas (`governance:migration:admin`): `GET|PUT /migration/external-ops`, `POST /migration/cutover/decision`, `GET /migration/rollback-report[?type=&page=]`, `POST /migration/rollback-items/:id/resolve`.
- Blockers da Torre: `GOV_ROLLBACK_COMPENSATION_REQUIRED` (tipo sem plano) e `GOV_ROLLBACK_PENDING` (compensação pendente de um rollback de setor).
- Ponto de extensão: `rollback/readiness.register(nome, fn)` acrescenta pré-requisitos ao GO (a M9-D908 registra a simulação de rollback no DRY3).

## Operação

- Variável de ambiente `MIGRATION_LEGACY_DB_URL`: endereço somente leitura da área `legado` (nunca em arquivo versionado).
- `MIGRATION_RUN_JOB_DISABLED=true` desliga o job que retoma execuções QUEUED.
- `PARALLEL_COMPARE_JOB_DISABLED=true` desliga o job da comparação paralela (M9-D903).
- Replay: `replay.replayBatch(tenant, actor, batchId)`.
