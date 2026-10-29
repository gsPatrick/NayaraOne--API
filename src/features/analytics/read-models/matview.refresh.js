'use strict';

/**
 * M9-D698 (3.2) — refresh CONCORRENTE de uma materialized view do BI (analytics.mv_*): a leitura nunca fica bloqueada. Roda a função
 * analytics.mv_refresh (SECURITY DEFINER; exige índice único e aplica statement_timeout e lock_timeout do refresh) e registra o refresh em
 * read_model_refreshes (trigger SCHEDULE, uma linha por grupo com as linhas dele) e avisa o cache dos painéis (analytics.read_model.refreshed).
 */
const { sequelize } = require('../../../models');
const AppError = require('../../../utils/AppError');
const clock = require('../metrics/clock');
const { enableAnalyticsWriter } = require('../metricStore.service');
const { startRefresh, finishRefresh } = require('../readModelRefreshStore.service');
const { REFRESH_DEFAULTS, KEYS: REFRESH_KEYS } = require('./readModel.settings');
const { getMaterializedView } = require('./matview.registry');
const { emitRefreshed } = require('./readModel.refreshed');

const pgCode = (err) => err?.parent?.code || err?.original?.code || err?.code;
const MAPPED = {
  ANA30: () => AppError.badRequest('Nome de materialized view inválido.', 'ANALYTICS_MV_UNKNOWN'),
  ANA31: () => AppError.notFound('Materialized view inexistente no banco.', 'ANALYTICS_MV_UNKNOWN'),
  ANA32: () => AppError.unprocessable('A materialized view precisa de índice único para o refresh concorrente.', 'ANALYTICS_MV_UNIQUE_INDEX_REQUIRED'),
  ANA33: () => AppError.internal('O dono da função de refresh precisa ignorar RLS para atualizar a view de todas as empresas.', 'ANALYTICS_MV_OWNER_RLS'),
};

async function runRefresh(name, params) {
  try {
    return await sequelize.transaction(async (transaction) => {
      const [[row]] = await sequelize.query('SELECT analytics.mv_refresh(:name, :statementMs, :lockMs) AS groups', {
        replacements: { name, statementMs: params.timeoutMs, lockMs: params.lockTimeoutMs }, transaction,
      });
      return row.groups || {};
    });
  } catch (err) {
    const mapped = MAPPED[pgCode(err)];
    if (mapped) { const e = mapped(); e.cause = err; throw e; }
    throw err;
  }
}

/** Uma linha de read_model_refreshes por grupo (company_id nulo: a view é do grupo). */
async function recordForGroup(def, groupId, rows, now) {
  const scope = { groupId, companyId: null };
  await sequelize.transaction(async (transaction) => {
    await sequelize.query("SELECT set_config('app.group_id', :g, true)", { replacements: { g: groupId }, transaction });
    await enableAnalyticsWriter(transaction);
    const row = await startRefresh({ groupId, companyId: null, readModel: def.name, trigger: 'SCHEDULE', version: def.version }, scope, transaction);
    const done = await finishRefresh(row.id, { status: 'SUCCEEDED', rowsUpserted: rows, sourceSnapshotAt: now }, scope, transaction);
    emitRefreshed(transaction, { readModel: def.name, companyId: null, groupId, refreshId: done.id });
  });
}

/** options: { now, params: { timeoutMs, lockTimeoutMs } } (padrões do livro quando ausentes). */
async function refreshMaterializedView(name, options = {}) {
  const def = getMaterializedView(name);
  if (!def) throw AppError.notFound('Materialized view não registrada.', 'ANALYTICS_MV_UNKNOWN');
  const params = {
    timeoutMs: options.params?.timeoutMs ?? REFRESH_DEFAULTS[REFRESH_KEYS.timeoutMs],
    lockTimeoutMs: options.params?.lockTimeoutMs ?? REFRESH_DEFAULTS[REFRESH_KEYS.lockTimeoutMs],
  };
  const now = options.now || clock.now();
  const groups = await runRefresh(def.name, params);
  let rows = 0;
  for (const [groupId, n] of Object.entries(groups)) {
    rows += Number(n);
    await recordForGroup(def, groupId, Number(n), now);
  }
  return { view: def.name, concurrently: true, groups: Object.keys(groups).length, rows };
}

module.exports = { refreshMaterializedView };
