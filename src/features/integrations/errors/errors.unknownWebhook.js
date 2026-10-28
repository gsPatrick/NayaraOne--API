'use strict';

const { sequelize } = require('../../../models');
const { UNKNOWN_PROVIDER_LABEL } = require('./errors.constants');

/**
 * Webhook de canal desconhecido (M9-D207 3.3): não identifica a empresa, então NÃO gera linha de erro de empresa. Só
 * incrementa um contador por hora e fornecedor em integration.platform_unknown_webhooks, sem payload, cabeçalho nem
 * origem. O código do fornecedor só é guardado se existir no catálogo; qualquer outro texto (vindo de quem chama sem
 * autenticação) é agregado em "(desconhecido)", o que limita o armazenamento.
 */
async function recordUnknownWebhook(providerCode, transaction) {
  await sequelize.query("SET LOCAL app.integration_platform_admin = 'on'", { transaction });
  const code = String(providerCode || '').toLowerCase().slice(0, 48);
  const [[achado]] = await sequelize.query('SELECT code FROM integration.providers WHERE code = :code', { replacements: { code }, transaction });
  await sequelize.query(
    `INSERT INTO integration.platform_unknown_webhooks (provider_code, bucket, hits)
     VALUES (:code, date_trunc('hour', now()), 1)
     ON CONFLICT (provider_code, bucket) DO UPDATE SET hits = integration.platform_unknown_webhooks.hits + 1, last_seen_at = now()`,
    { replacements: { code: achado ? achado.code : UNKNOWN_PROVIDER_LABEL }, transaction }
  );
  await sequelize.query("SET LOCAL app.integration_platform_admin = 'off'", { transaction });
}

module.exports = { recordUnknownWebhook };
