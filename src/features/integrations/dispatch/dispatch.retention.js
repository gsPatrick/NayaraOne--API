'use strict';

const { sequelize } = require('../../../models');
const { readDispatchParams } = require('./dispatch.params');

/**
 * Retenção dos envios da empresa da sessão: troca o conteúdo por {"redacted":true,"hash":...} depois de
 * `integration.dispatch.payload_retention_days` e apaga o envio CONFIRMED/CANCELLED depois de `retention_days`.
 * A função SECURITY DEFINER integration.purge_dispatches é a única que liga a marca de redação; M9-D244 a chama de
 * integration.purge_expired().
 */
async function purgeDispatches(ctx, transaction) {
  const p = await readDispatchParams(ctx, transaction);
  const [[{ r }]] = await sequelize.query('SELECT "integration".purge_dispatches(:days, :payload) AS r', {
    replacements: { days: p.retentionDays, payload: p.payloadRetentionDays }, transaction,
  });
  return r;
}

module.exports = { purgeDispatches };
