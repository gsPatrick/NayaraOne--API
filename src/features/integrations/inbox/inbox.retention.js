'use strict';

const { purgeExpired } = require('../retention');

/**
 * Retenção da caixa de entrada da empresa da sessão: anula o corpo bruto (mantém o hash) e depois apaga a linha, pelos
 * prazos integration.inbox.*. Só integration.purge_expired() (M9-D244) faz isso; o runtime não tem DELETE.
 */
async function purgeWebhookInbox(ctx, transaction) {
  const r = await purgeExpired(ctx, transaction, { areas: ['inbox'] });
  return r.webhook_inbox;
}

module.exports = { purgeWebhookInbox };
