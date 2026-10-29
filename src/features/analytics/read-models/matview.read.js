'use strict';

/**
 * M9-D698 (3.2) — leitura de uma materialized view do BI pela função SECURITY DEFINER dela, que devolve só as linhas da empresa e do grupo da
 * sessão (a view não tem RLS e o role de runtime não a lê direto). A transação traz as GUCs de tenant, como toda consulta do BI.
 */
const { sequelize } = require('../../../models');
const AppError = require('../../../utils/AppError');
const { getMaterializedView } = require('./matview.registry');

async function readMaterializedView(name, scope, transaction) {
  const def = getMaterializedView(name);
  if (!def || !def.readFunction) throw AppError.notFound('Materialized view não disponível para leitura.', 'ANALYTICS_MV_UNKNOWN');
  const [rows] = await sequelize.query(`SELECT * FROM analytics.${def.readFunction}()`, { transaction });
  return rows;
}

module.exports = { readMaterializedView };
