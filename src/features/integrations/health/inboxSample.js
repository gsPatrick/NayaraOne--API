'use strict';

const { sequelize } = require('../../../models');
const { registerHealthSampleSource } = require('./sampleSources');

/**
 * Fonte de amostras da caixa de entrada de webhooks (M9-D224 3.1): completa, na saúde da connection, o que as tentativas de envio
 * (M9-D218) não enxergam. `backlog` soma os eventos RECEIVED e FAILED que ainda esperam processamento (o estoque de agora) e `dlq` os
 * eventos que chegaram na janela e foram parar em DEAD_LETTER. Só contagens: nenhum corpo de evento sai daqui.
 */
async function inboxHealthSample({ connection, from, to }, transaction) {
  const [rows] = await sequelize.query(
    `SELECT count(*) FILTER (WHERE status IN ('RECEIVED', 'FAILED'))::int AS backlog,
            count(*) FILTER (WHERE status = 'DEAD_LETTER' AND received_at >= :from AND received_at <= :to)::int AS dlq
       FROM "integration"."webhook_inbox" WHERE connection_id = :id`,
    { replacements: { id: connection.id, from, to }, transaction },
  );
  return { backlogCount: rows[0].backlog, dlqCount: rows[0].dlq };
}

/** Liga a fonte ao agregador de saúde (chamada no boot do app). */
const registerInboxHealthSource = () => registerHealthSampleSource(inboxHealthSample);

module.exports = { inboxHealthSample, registerInboxHealthSource };
