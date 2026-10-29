'use strict';

/**
 * M9-D628 — rm_tech_queues: por fila (`outbox` = integration.outbox_events; `inbox` = integration.integration_inbox, por consumidor) e tipo de evento, os itens
 * aguardando (`depth`), o instante do mais antigo (`oldest_at`) e os que esgotaram as tentativas (`dlq_depth`). A idade em segundos sai de `source_snapshot_at - oldest_at`
 * na leitura (DI-D628-3: a coluna oldest_age_seconds do caderno passa a ser derivada para o rebuild reproduzir o incremental). Aguardando = PENDING (outbox) e RECEIVED,
 * PROCESSING ou FAILED (inbox); DLQ = DEAD_LETTER (outbox) e DEAD (inbox). Só tipos com algum item entram. Fonte lida sob a RLS da empresa.
 */
const { select, defineCompanyWideModel, toRow } = require('./common');

const KEY = ['queue', 'event_type'];

async function build({ companyId, transaction }) {
  const records = await select(
    `SELECT 'outbox' AS queue, event_type, (count(*) FILTER (WHERE status = 'PENDING'))::int AS depth, min(created_at) FILTER (WHERE status = 'PENDING') AS oldest_at,
            (count(*) FILTER (WHERE status = 'DEAD_LETTER'))::int AS dlq_depth
       FROM integration.outbox_events WHERE company_id = :companyId AND status IN ('PENDING', 'DEAD_LETTER') GROUP BY event_type
     UNION ALL
     SELECT 'inbox' AS queue, consumer_name AS event_type, (count(*) FILTER (WHERE status IN ('RECEIVED', 'PROCESSING', 'FAILED')))::int AS depth,
            min(created_at) FILTER (WHERE status IN ('RECEIVED', 'PROCESSING', 'FAILED')) AS oldest_at, (count(*) FILTER (WHERE status = 'DEAD'))::int AS dlq_depth
       FROM integration.integration_inbox WHERE company_id = :companyId AND status IN ('RECEIVED', 'PROCESSING', 'FAILED', 'DEAD') GROUP BY consumer_name
     ORDER BY 1, 2`,
    { companyId }, transaction
  );
  return records.map(toRow(KEY));
}

const def = defineCompanyWideModel({ name: 'rm_tech_queues', keyColumns: KEY, build });

module.exports = { def, build };
