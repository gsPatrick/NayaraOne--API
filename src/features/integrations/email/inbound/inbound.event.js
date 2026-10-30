'use strict';

const { IntegrationConnection } = require('../../../../models');
const { ingestInboundEmail } = require('./inbound.ingest');
const { DUPLICATE_CODE } = require('./inbound.constants');

/**
 * Evento `INBOUND` do domínio EMAIL (M9-D235): a mensagem recebida chega pelo webhook assinado (D211) ou pela leitura periódica e entra no pipeline. O conteúdo vem em `ev.private`
 * (nunca vai ao outbox); a repetição do mesmo identificador do provedor é ignorada (`INTEGRATION_EMAIL_INBOUND_DUPLICATE_IGNORED`, 200).
 */
async function applyInboundEvent(ctx, row, ev, transaction) {
  const connection = await IntegrationConnection.findByPk(row.connectionId, { transaction });
  if (!connection) return { applied: false };
  const priv = ev.private || {};
  const r = await ingestInboundEmail(ctx, { connection, inboxId: row.id, message: { externalMessageId: ev.data.externalMessageId, ...priv } }, transaction);
  return r.duplicate ? { applied: false, code: DUPLICATE_CODE } : { applied: true };
}

module.exports = { applyInboundEvent };
