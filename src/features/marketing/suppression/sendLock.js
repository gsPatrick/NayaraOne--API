'use strict';

const { sequelize } = require('../../../models');

const lockKey = (companyId, personId, channel, purpose) => `mkt_send:${companyId}:${personId}:${String(channel).toUpperCase()}:${String(purpose).toUpperCase()}`;

/**
 * Trava única de pessoa + canal + finalidade (M9-D416/M9-D418): o canSend com a reserva do envio e a inserção da supressão tomam
 * ESTA MESMA trava (`pg_advisory_xact_lock`, solta no fim da transação). Quem pega primeiro vence; a checagem relê o estado
 * depois de obter a trava. Várias travas são tomadas em ordem alfabética para duas transações nunca se travarem uma na outra.
 */
async function acquireSendLocks(tenant, personId, channel, purposes, transaction) {
  if (!transaction) return;
  const keys = [...new Set(purposes.map((p) => lockKey(tenant.companyId, personId, channel, p)))].sort();
  for (const key of keys) {
    await sequelize.query('SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))', { replacements: { key }, transaction });
  }
}

module.exports = { acquireSendLocks, lockKey };
