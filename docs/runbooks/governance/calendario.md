# Runbook — Calendário unificado (reprocessar projeção e replay)

Módulo: `src/features/core-governance/calendar` (README do módulo para as regras). Rotas sob `$API/calendar`. Permissões: `governance:calendar:read`.

Convenções deste runbook: `$API` é a base da API do ambiente (por exemplo `https://<host do ambiente>/api/v1`) e `$TOKEN` é o token de acesso de quem opera, obtido pelo login normal da tela (nunca anotado em arquivo). Comandos `node -e` rodam no servidor do ambiente, com as variáveis do próprio ambiente; em máquina de desenvolvimento use sempre banco descartável (`node scripts/withDisposableDb.js --port <porta> -- ...`), nunca o banco do `.env`.

## Sintoma
- Um item que deveria estar na agenda não aparece (visita, prazo jurídico, cobrança, garantia, etapa de obra).
- Um item aparece duplicado, fechado quando a origem ainda está aberta, ou aberto quando a origem já foi concluída.
- Alertas de vencido ou de conflito não chegam.

## Causa provável
1. A pessoa não tem a permissão do módulo de origem (o total já desconta o que ela não pode ver).
2. O evento da origem ficou pendente no outbox (o projetor consome por evento) ou foi para `DEAD` por tipo sem mapeamento (`GOV_CALENDAR_EVENT_UNKNOWN`).
3. A varredura diária (`calendarBackfillJob`) ainda não passou para registros anteriores à entrega do módulo.
4. Módulo desligado para a empresa (`GOV_MODULE_DISABLED`).

## Passo a passo
1. Consultar a janela do item e conferir a permissão:
   ```bash
   curl -s -H "Authorization: Bearer $TOKEN" "$API/calendar?from=2026-01-01&to=2026-12-31&sourceType=LEGAL_DEADLINE&pageSize=50"
   ```
   Conferir `meta.from`, `meta.to` e o `status`; na tela de Configurações > Governança, a chave `governanca.calendario.permissao_por_fonte` diz qual permissão cada origem exige.
2. Reprocessar a projeção dos registros já existentes (idempotente: rodar duas vezes não duplica, a chave é empresa + tipo + origem):
   ```bash
   node -e "require('./src/engines/jobs/calendarBackfillJob').runCalendarBackfillJob(new Date(), { force: true }).then((r) => { console.log(r); process.exit(0); })"
   ```
3. Replay de um evento específico: o projetor tem inbox por `event_id`; reenviar o mesmo evento não muda nada (`IGNORED_STALE`/`IGNORED_TRANSITION`). Para reprocessar um evento pendente basta o worker do outbox seguir rodando; para provar o comportamento em ambiente de desenvolvimento:
   ```bash
   node scripts/withDisposableDb.js --port 55321 -- env CI_TENANT_USERS_PASSWORD=ci-tenant-users-password-not-for-production bash -c "node scripts/seed-ci-two-tenants.js >/dev/null && NODE_ENV=test node --test --test-concurrency=1 test/marco9/governanca/m9d802.projetor.test.js"
   ```
4. Alertas fora do horário: rodar os jobs na hora (a deduplicação por dia impede aviso repetido):
   ```bash
   node -e "require('./src/engines/jobs/calendarOverdueJob').runCalendarOverdueJob(new Date(), { force: true }).then(() => process.exit(0))"
   node -e "require('./src/engines/jobs/calendarConflictJob').runCalendarConflictJob(new Date(), { force: true }).then(() => process.exit(0))"
   ```
5. Se o ambiente precisar parar a projeção por incidente: `CALENDAR_BACKFILL_JOB_DISABLED=true`, `CALENDAR_OVERDUE_JOB_DISABLED=true` ou `CALENDAR_CONFLICT_JOB_DISABLED=true` no processo (os eventos continuam no outbox).

## Como confirmar
- O `GET /calendar` do passo 1 devolve o item com `isOverdue` coerente e `deepLink` que abre a origem.
- A segunda execução do passo 2 devolve `inserted` zero para o mesmo conjunto (replay não duplica).
- O `traceId` da resposta de erro é o `X-Correlation-Id`: procurar nos logs e na auditoria (`entity_type = governance.calendar_commitment` para compromissos).

## Quem escalar
Primeiro o responsável do domínio da origem (jurídico, financeiro, obras); persistindo, o time de plataforma (dono do módulo de governança) com o `traceId` e o `source_type`/`source_id` do item.
