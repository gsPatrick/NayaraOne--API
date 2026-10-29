'use strict';

/**
 * M9-D624 — liga o cálculo dos KPIs financeiros ao fim de cada lote de refresh do rm_finance_health (evento e agenda, M9-D607), na mesma
 * transação do refresh. Falha aqui nunca derruba a projeção: vai para o log e o KPI segue com o snapshot anterior (que continua legível).
 */
const { sequelize } = require('../../../../models');
const logger = require('../../../../utils/logger');
const { onBatchFlushed } = require('../../read-models');
const { materializeFinanceKpis } = require('./finance.materialize');
const { SOURCE_READ_MODEL } = require('./finance.definitions');

async function onFlushed(entry, transaction) {
  if (entry.readModel !== SOURCE_READ_MODEL) return;
  try {
    await sequelize.transaction({ transaction }, async (savepoint) => {
      // a data-base é a da linha que o refresh acabou de gravar (a de hoje; em teste, a do relógio injetado)
      const [rows] = await sequelize.query(
        `SELECT as_of_date::text AS as_of_date FROM analytics.${SOURCE_READ_MODEL} WHERE company_id = :companyId ORDER BY refreshed_at DESC, as_of_date DESC LIMIT 1`,
        { replacements: { companyId: entry.companyId }, transaction: savepoint }
      );
      if (rows.length) await materializeFinanceKpis({ companyId: entry.companyId, groupId: entry.groupId }, rows[0].as_of_date, savepoint);
    });
  } catch (err) {
    logger.error({ event: 'analytics.kpi.finance_failed', companyId: entry.companyId, err }, '[analytics] não foi possível calcular os KPIs financeiros do refresh');
  }
}

let installed = false;
function install() {
  if (installed) return;
  installed = true;
  onBatchFlushed(onFlushed);
}

module.exports = { install, onFlushed };
