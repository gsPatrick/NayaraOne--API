'use strict';

/**
 * M9-D696 (3.2) — liga os checks aos dois pontos de execução: o fim de cada lote de refresh (M9-D607: eventos e agenda) e o rebuild sobre a
 * tabela sombra (M9-D608, `onRebuildChecks`). Falha ao rodar/gravar no fim do lote nunca derruba a projeção: vai para o log de erro
 * (a transação do despacho fica protegida por savepoint) e o dataset segue sem selo novo até a próxima execução.
 */
const { sequelize } = require('../../../models');
const logger = require('../../../utils/logger');
const { onBatchFlushed, onRebuildChecks } = require('../read-models');
const { getChecks } = require('./quality.catalog');
const { checkRefresh } = require('./quality.record');
const { executeChecks } = require('./quality.execute');

async function onFlushed(entry, transaction) {
  if (!getChecks(entry.readModel).length) return;
  const input = {
    readModel: entry.readModel, scope: { companyId: entry.companyId, groupId: entry.groupId }, refreshId: entry.refreshId,
    rowsUpserted: entry.rowsUpserted, mode: 'EVENT',
  };
  try {
    await sequelize.transaction({ transaction }, (savepoint) => checkRefresh(input, savepoint));
  } catch (err) {
    logger.error({ event: 'analytics.quality.run_failed', readModel: entry.readModel, companyId: entry.companyId, err }, '[analytics] não foi possível rodar/gravar os checks de qualidade do refresh');
  }
}

/** Executor do rebuild: roda o catálogo sobre a sombra e devolve os resultados (quem grava e decide o aborto é o rebuild). */
function rebuildExecutor({ readModel, companyId, groupId, shadowTable, refreshId, transaction }) {
  return executeChecks({ readModel, scope: { companyId, groupId }, table: shadowTable, refreshId, mode: 'REBUILD' }, transaction);
}

let installed = false;
function install() {
  if (installed) return;
  installed = true;
  onBatchFlushed(onFlushed);
  onRebuildChecks(rebuildExecutor);
}

module.exports = { install, onFlushed, rebuildExecutor };
