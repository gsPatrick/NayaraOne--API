'use strict';

/**
 * M9-D650 / M9-D651 — liga o cálculo dos KPIs de Obras ao fim de cada lote de refresh dos read models de Obras (evento e agenda, M9-D607), na mesma
 * transação do refresh. O lote termina com todos os read models da empresa já gravados, por isso o cálculo roda UMA vez por empresa e transação (os
 * demais avisos do mesmo lote não repetem). Falha aqui nunca derruba a projeção: vai para o log e o KPI segue com o snapshot anterior (legível).
 */
const { sequelize } = require('../../../../../models');
const logger = require('../../../../../utils/logger');
const { onBatchFlushed } = require('../../../read-models');
const { rootOf } = require('../../../read-models/readModel.batch');
const clock = require('../../clock');
const { materializeObraKpis } = require('./materialize');
const { KPI_DEFINITIONS } = require('./definitions');

const WATCHED = new Set(KPI_DEFINITIONS.map((d) => d.sourceReadModel)); // os read models de origem dos KPIs publicados
const done = new WeakMap(); // transação raiz -> empresas já calculadas neste lote

async function onFlushed(entry, transaction) {
  if (!WATCHED.has(entry.readModel)) return;
  const root = rootOf(transaction);
  const companies = done.get(root) || new Set();
  if (companies.has(entry.companyId)) return;
  companies.add(entry.companyId);
  done.set(root, companies);
  try {
    await sequelize.transaction({ transaction }, async (savepoint) => {
      await materializeObraKpis({ companyId: entry.companyId, groupId: entry.groupId }, clock.businessToday(), savepoint); // os read models de Obras guardam o estado de hoje
    });
  } catch (err) {
    logger.error({ event: 'analytics.kpi.obras_failed', companyId: entry.companyId, err }, '[analytics] não foi possível calcular os KPIs de Obras do refresh');
  }
}

let installed = false;
function install() {
  if (installed) return;
  installed = true;
  onBatchFlushed(onFlushed);
}

module.exports = { install, onFlushed };
