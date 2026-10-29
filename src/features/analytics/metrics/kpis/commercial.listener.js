'use strict';

/**
 * M9-D632 / M9-D633 — liga o cálculo dos KPIs de Comercial e Imóveis ao fim de cada lote de refresh dos read models de origem (evento e agenda,
 * M9-D607), na mesma transação do refresh: só recalcula os KPIs do read model que acabou de ser atualizado, com a data-base de hoje (São Paulo, relógio
 * injetável). Falha aqui nunca derruba a projeção: vai para o log e o KPI segue com o snapshot anterior (que continua legível).
 */
const { sequelize } = require('../../../../models');
const logger = require('../../../../utils/logger');
const clock = require('../clock');
const { onBatchFlushed } = require('../../read-models');
const { materializeCommercialKpis, codesOfModel } = require('./commercial.materialize');

async function onFlushed(entry, transaction) {
  const only = codesOfModel(entry.readModel);
  if (!only.length) return;
  try {
    await sequelize.transaction({ transaction }, async (savepoint) => {
      await materializeCommercialKpis({ companyId: entry.companyId, groupId: entry.groupId }, clock.businessToday(), savepoint, { only });
    });
  } catch (err) {
    logger.error({ event: 'analytics.kpi.commercial_failed', companyId: entry.companyId, err }, '[analytics] não foi possível calcular os KPIs de Comercial e Imóveis do refresh');
  }
}

let installed = false;
function install() {
  if (installed) return;
  installed = true;
  onBatchFlushed(onFlushed);
}

module.exports = { install, onFlushed };
