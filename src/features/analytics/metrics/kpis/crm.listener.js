'use strict';

/**
 * M9-D630 / M9-D631 — liga o cálculo dos KPIs do funil comercial ao fim de cada lote de refresh dos read models do CRM (evento e agenda, M9-D607), na
 * mesma transação do refresh, para a data-base de hoje em São Paulo. Falha aqui nunca derruba a projeção: vai para o log e o KPI segue com o snapshot
 * anterior (que continua legível).
 */
const { sequelize } = require('../../../../models');
const logger = require('../../../../utils/logger');
const clock = require('../clock');
const { onBatchFlushed } = require('../../read-models');
const { materializeCrmKpis } = require('./crm.materialize');
const { READ_MODELS } = require('./crm.definitions');

const WATCHED = new Set(Object.values(READ_MODELS));

async function onFlushed(entry, transaction) {
  if (!WATCHED.has(entry.readModel)) return;
  try {
    await sequelize.transaction({ transaction }, async (savepoint) => {
      await materializeCrmKpis({ companyId: entry.companyId, groupId: entry.groupId }, clock.businessToday(), savepoint);
    });
  } catch (err) {
    logger.error({ event: 'analytics.kpi.crm_failed', companyId: entry.companyId, err }, '[analytics] não foi possível calcular os KPIs do funil comercial do refresh');
  }
}

let installed = false;
function install() {
  if (installed) return;
  installed = true;
  onBatchFlushed(onFlushed);
}

module.exports = { install, onFlushed };
