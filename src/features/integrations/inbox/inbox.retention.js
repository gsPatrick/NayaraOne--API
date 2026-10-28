'use strict';

const { sequelize } = require('../../../models');
const { readInboxParams } = require('./inbox.params');

/**
 * Retenção da caixa de entrada da empresa da sessão: anula o corpo bruto (mantém o hash) e depois apaga a linha.
 * A remoção é da função SECURITY DEFINER integration.purge_webhook_inbox (o runtime não tem DELETE); M9-D244 a chama
 * de integration.purge_expired().
 */
async function purgeWebhookInbox(ctx, transaction) {
  const p = await readInboxParams(ctx, transaction);
  const [[{ r }]] = await sequelize.query('SELECT "integration".purge_webhook_inbox(:raw, :days, :dlq) AS r', {
    replacements: { raw: p.rawRetentionDays, days: p.retentionDays, dlq: p.dlqRetryRetentionDays }, transaction,
  });
  return r;
}

module.exports = { purgeWebhookInbox };
