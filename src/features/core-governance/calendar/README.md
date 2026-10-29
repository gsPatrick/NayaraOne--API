# Governança — Calendário unificado (`calendar`)

## Objetivo
Calendário unificado: uma agenda única, sem ser nova fonte de verdade. `calendar_items` guarda por item só `source_type`, `source_id`, `title`, `owner`, `due_at`, `severity`, `status` e `deep_link` (mais apoio técnico) e aponta de volta para a origem. M9-D801 entrega a tabela, a origem dos compromissos avulsos e o `GET /calendar`; M9-D802 (projetor por eventos, alertas) e M9-D803 (origens de obras e garantias) usam estas tabelas e `calendar.projection.store.js`.

## Tabelas
- `governance.calendar_items` (lista única de colunas do M9-D801 §3.1; `UNIQUE (company_id, source_type, source_id)`; `deep_link` relativo validado por CHECK; "vencido" NÃO é coluna).
- `governance.calendar_commitments` (origem do tipo COMMITMENT: título, início, fim, responsável, status).
- Migration `20260101000801-create-governance-calendar.js`; as duas tabelas chamam `governance.apply_tenant_rls` (RLS + FORCE RLS).

## Rotas e permissões
- `GET /calendar` (`governance:calendar:read`): filtros `from`, `to` (ISO ou AAAA-MM-DD; padrão hoje 00:00 até hoje + janela, em America/Sao_Paulo), `sourceType` (lista), `ownerUserId`, `status`, `page`, `pageSize` (1 a 200). Ordem `due_at` e `id`. Só aparecem itens cuja origem a pessoa pode ler (permissão do módulo de origem, mapa configurável); o total reflete a omissão. Resposta: `data` (itens, com `isOverdue` derivado), `pagination`, `meta {from,to,timezone}`.
- `POST /calendar/commitments`, `GET|PATCH /calendar/commitments/:id`: compromisso avulso. Criar exige `governance:calendar:read`; alterar exige ser a pessoa responsável ou ADMIN.
- `PATCH`, `PUT` e `DELETE` em `/calendar/items/:id`: 404 `GOV_NOT_FOUND` (item é derivado; o status muda só pelo projetor).
- Erros: `PERMISSION_DENIED` 403, `GOV_CALENDAR_RANGE_INVALID` 400, `GOV_CALENDAR_SOURCE_INVALID` 400, `GOV_COMMITMENT_INVALID` 400, `GOV_COMMITMENT_OWNER_ONLY` 403, `GOV_COMMITMENT_TRANSITION_INVALID` 409, `VALIDATION_ERROR` 400, `GOV_NOT_FOUND` 404, `GOV_MODULE_DISABLED` 403.

## Eventos
- `calendar.item.updated` é publicado pelo projetor (M9-D802) ao gravar o item; M9-D801 não publica evento.

### Fontes de obras e garantias (M9-D803)
- `sources/` (funções puras, sem banco): `mapSourceEvent(event, {companyId, severityMap})` devolve `{ items, transitions }`. `items` são rascunhos para `upsertItem`; `transitions` são fechamentos (`DONE` ou `CANCELLED` com `cancelReason`) que o projetor aplica pela matriz de M9-D802. Item com `preserveStatus` (escalonamento de caso em garantia) só sobe a severidade: o projetor não reabre item fechado. Evento de outra empresa: `GOV_CALENDAR_TENANT_MISMATCH`; tipo sem origem: `GOV_CALENDAR_EVENT_UNKNOWN`.
- CONSTRUCTION (`source_kind` STAGE ou PROJECT): `project.stage.updated` (novo), `project.stage.completed`, `project.created|started|delivered|closed`, `construction.project.status_changed`, `project.schedule.updated` (novo, DI-D803-3). GUARANTEE (`source_kind` LEGAL_GUARANTEE, WARRANTY_CASE ou PROJECT_WARRANTY): `legal.guarantee.created|updated|ended|replaced`, `warranty.case.opened|escalated|closed`, `project.warranty_started` (agora com `warrantyEndsAt`). Os publicadores novos estão em `features/construction/constructionCalendarEvents.service.js` e `features/legal/legalCalendarEvents.service.js`.
- `calendarBackfillJob` (`src/engines/jobs`): varredura diária por empresa na hora de `governanca.calendario.varredura_hora` (padrão 6, America/Sao_Paulo) que traz os registros abertos já existentes (idempotente), fecha `PROJECT_WARRANTY` vencido lendo só `calendar_items` e cancela (`SOURCE_NOT_OPEN`) item aberto cuja origem não está mais aberta. Desligar no processo: `CALENDAR_BACKFILL_JOB_DISABLED=true`.
- Parâmetro `governanca.calendario.garantia_obra_meses` (60): meses de garantia somados à data da entrega para o `warrantyEndsAt`.

### Projetor por eventos (M9-D802)
- `projector/calendar.projector.js` (`projectEvent`) é registrado no outbox para todos os eventos de origem mapeados (`projector/projector.consumer.js`, ligado em `index.js`). Idempotência dupla: inbox por `event_id` (consumidor `governance.calendar.projector`) e UPSERT por `(company_id, source_type, source_id)`. Roda como savepoint de nome único (`engines/events/savepoint.js`): falha em qualquer passo desfaz item, evento de saída, auditoria e inbox, e o evento segue pendente.
- Ordem e versão: evento com `occurredAt` anterior ao gravado (`last_event_occurred_at`) é ignorado (inbox `IGNORED_STALE`). Empate: prevalece DONE, depois CANCELLED, depois OPEN. Transição fora da matriz de §3.2.1 é `IGNORED_TRANSITION` (regras puras em `projector/projector.state.js`; aplicação e gravação em `projector/projector.apply.js`).
- Mapa de eventos por fonte em `sources/` (`crm.source.js`: CRM_TASK e VISIT; `legal.source.js`: LEGAL_DEADLINE e RENEWAL; `finance.source.js`: BILLING e FISCAL; `maintenance.source.js`: MAINTENANCE; `construction.source.js` e `guarantee.source.js` de M9-D803). Cada módulo de origem publica o seu evento na própria transação (`calendar.publisher.js`).
- Evento de saída `calendar.item.updated` `{itemId, sourceType, sourceId, changes:{campo:{antes,apos}}}`, chave `calendar.item.updated:<itemId>:<projection_version>`: uma vez por mudança efetiva (projetor, compromissos avulsos e fechamentos da varredura de M9-D803). Replay não muda a versão.
- Evento de empresa diferente da sessão ou com `companyId` divergente no payload: descartado e auditado (`GOV_CALENDAR_TENANT_MISMATCH`). Tipo sem mapeamento: inbox `DEAD` com `GOV_CALENDAR_EVENT_UNKNOWN`. Módulo desligado: ignora.
- Novas operações de origem criadas para fechar o item na origem: `PATCH /tasks/:id` (tarefa do CRM), `PATCH /maintenance-orders/:id/schedule` (reagendar manutenção) e `POST /procurement/insurance-renewal-tasks/:id/complete` (renovação de apólice). Não existe rota de conclusão no calendário.

## Jobs e horários
`calendarBackfillJob` (M9-D803, diário na hora configurada, padrão 06:00 America/Sao_Paulo), `calendarOverdueJob` e `calendarConflictJob` (M9-D802).

### Alertas (M9-D802 §3.5)
Leem SÓ `governance.calendar_items` (decisão K9). Chave de deduplicação em `governance.calendar_alert_log` (UNIQUE por empresa).
- Vencido (`calendarOverdueJob`, diário na hora `governanca.calendario.alerta_vencido_hora`, padrão 06:00 Brasília): `Notification` IN_APP ao responsável ou, sem usuário, a cada usuário ativo do perfil de `owner_team`; uma vez por item e por dia (`calendar.overdue:<item>:<AAAA-MM-DD>`).
- Conflito (`calendarConflictJob`, a cada `governanca.calendario.conflito_intervalo_min`, padrão 15): itens OPEN das fontes `governanca.calendario.fontes_conflito` (VISIT, COMMITMENT, MAINTENANCE) do mesmo responsável com janelas que se sobrepõem em algum minuto (11:00-11:00 não conflita); janela = `end_at` ou início + `duracao_padrao_min`; um alerta por par e por dia (`calendar.conflict:<menorId>:<maiorId>:<AAAA-MM-DD>`).
- Desligar no processo: `CALENDAR_OVERDUE_JOB_DISABLED=true`, `CALENDAR_CONFLICT_JOB_DISABLED=true`.

## Parâmetros
Aba Governança em /painel/configuracoes (padrão = `Maturacao/demandas/parametros.csv`):
- `governanca.modulos.calendar.habilitado` (padrão ligado).
- `governanca.calendario.severidade_por_fonte`: `FONTE=NIVEL` (padrão: LEGAL_DEADLINE e FISCAL = CRITICAL; BILLING e GUARANTEE = WARNING; demais INFO). Lido ao projetar o compromisso e pelo projetor.
- `governanca.calendario.permissao_por_fonte`: permissão do módulo de origem por tipo (`|` = qualquer uma). Lido a cada `GET /calendar`.
- `governanca.calendario.permissao_por_tipo_origem` (`LEGAL_GUARANTEE=legal:read, WARRANTY_CASE=construction:read, PROJECT_WARRANTY=construction:read`): permissão extra por tipo de item (`source_kind`) dentro da origem; a origem GUARANTEE mistura fiança (jurídico) e garantia de obra (obras), e quem só tem uma das permissões não vê o tipo da outra. Tipo fora da lista segue só a regra da origem.
- `governanca.calendario.janela_padrao_dias` (30) e `governanca.calendario.tamanho_pagina_padrao` (50): consulta sem filtros.
- `governanca.calendario.duracao_padrao_min` (60): fim de compromisso sem `endsAt`; M9-D802 usa o mesmo valor para visita e manutenção.
- `governanca.calendario.papel_por_fonte` (`BILLING=financeiro, FISCAL=fiscal`): perfil que recebe o aviso quando a origem não tem responsável (gravado em `owner_team`).
- `governanca.calendario.fontes_conflito` (`VISIT, COMMITMENT, MAINTENANCE`), `governanca.calendario.alerta_vencido_hora` (6) e `governanca.calendario.conflito_intervalo_min` (15).

## Decisões (ADR)
- K5: corpo de erro único com `error.traceId`; K4: código novo com prefixo `GOV_`.
- DI-D801-1 a DI-D801-6 em `Maturacao/demandas/decisoes-de-implementacao.md` (permissão por origem configurável, severidade em texto `FONTE=NIVEL`, janela e página como parâmetro, duração padrão do compromisso, dono do compromisso, deep link do compromisso).
- Único ponto de escrita em `calendar_items`: `calendar.projection.store.js` (UPSERT por origem na transação do chamador).

## Como testar
`test/m9d801.calendario.regras.test.js` e `test/m9d801.calendario.http.test.js` em banco descartável: `node scripts/withDisposableDb.js --port <55000-55999> -- env CI_TENANT_USERS_PASSWORD=... bash -c "node scripts/seed-ci-two-tenants.js >/dev/null && NODE_ENV=test node --test --test-concurrency=1 <arquivos>"`. Nunca contra o banco do `.env`.

## Como diagnosticar
- Item não aparece: conferir a janela (`meta.from`/`meta.to`), o status e se a pessoa tem a permissão da origem (`governanca.calendario.permissao_por_fonte`); o total já desconta o que ela não pode ver.
- Compromisso sem item: o item é gravado na mesma transação; consultar `governance.calendar_items` por `source_type = 'COMMITMENT'` e `source_id`.
- `traceId` da resposta de erro = `X-Correlation-Id`, para achar a requisição nos logs e na auditoria (`entity_type = governance.calendar_commitment`).
