'use strict';

/**
 * M9-D608 (3.2 passos 1 e 6) — diário do rebuild em read_model_refreshes (trigger REBUILD): abre em RUNNING, e fecha como SUCCEEDED
 * ou FAILED guardando o motivo (--motivo) e a diferença entre a tabela atual e a sombra. Cada passo roda em transação própria do
 * chamador, porque a falha da reconstrução desfaz a transação de trabalho mas o diário da tentativa tem de ficar.
 */
const { sequelize } = require('../../../models');
const { enableAnalyticsWriter } = require('../metricStore.service');
const { startRefresh, finishRefresh } = require('../readModelRefreshStore.service');

async function openRebuild(def, scope, reason, transaction) {
  await enableAnalyticsWriter(transaction);
  const row = await startRefresh({ groupId: scope.groupId, companyId: scope.companyId, readModel: def.name, trigger: 'REBUILD', version: def.version }, scope, transaction);
  if (reason) await sequelize.query('UPDATE analytics.read_model_refreshes SET rebuild_reason = :reason WHERE id = :id', { replacements: { reason, id: row.id }, transaction });
  return row;
}

async function saveDiff(refreshId, diff, transaction) {
  if (!diff) return;
  await sequelize.query('UPDATE analytics.read_model_refreshes SET rebuild_diff = CAST(:diff AS jsonb) WHERE id = :id', { replacements: { diff: JSON.stringify(diff), id: refreshId }, transaction });
}

/** Fecha o diário. `patch` segue finishRefresh; `diff` vai para rebuild_diff. Não faz nada se o registro já foi encerrado. */
async function closeRebuild(refreshId, scope, patch, diff, transaction) {
  await enableAnalyticsWriter(transaction);
  const [[row]] = await sequelize.query('SELECT status FROM analytics.read_model_refreshes WHERE id = :id', { replacements: { id: refreshId }, transaction });
  if (!row || row.status !== 'RUNNING') return null;
  const done = await finishRefresh(refreshId, patch, scope, transaction);
  await saveDiff(refreshId, diff, transaction);
  return done;
}

module.exports = { openRebuild, closeRebuild };
