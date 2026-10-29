'use strict';

/**
 * M9-D630 — leitura dos read models do CRM para o cálculo dos KPIs do funil. Só lê o schema analytics (nunca o OLTP): o valor sai do estado
 * que o worker de read models gravou (M9-D607). O período é o mês de São Paulo da data-base (M9-D606, mesmo padrão do resolvedor de período): do dia
 * 1 até a data-base. A tabela vem de constantes (a varredura de segurança M9-D700 só deixa citar o nome do read model na camada read-models).
 */
const { sequelize } = require('../../../../models');
const { READ_MODELS } = require('./crm.definitions');

const T = Object.freeze({ leads: READ_MODELS.lead });

const monthOf = (asOfDate) => asOfDate.slice(0, 7);

async function query(sql, replacements, transaction) {
  const [rows] = await sequelize.query(sql, { replacements, transaction });
  return rows;
}

/** Instante mais recente em que algum dos read models foi alimentado com dado da fonte (source_snapshot_at); nulo se nunca foi. */
async function latestSnapshotAt(companyId, models, transaction) {
  const parts = models.map((m) => `SELECT max(source_snapshot_at) AS at FROM analytics.${m} WHERE company_id = :companyId`).join(' UNION ALL ');
  const [rows] = await sequelize.query(`SELECT max(at) AS at FROM (${parts}) x`, { replacements: { companyId }, transaction });
  const refreshed = await query(
    'SELECT max(source_snapshot_at) AS at FROM analytics.read_model_refreshes WHERE company_id = :companyId AND read_model IN (:models) AND status IN (\'SUCCEEDED\', \'DEGRADED\')', { companyId, models }, transaction
  );
  const times = [rows[0] && rows[0].at, refreshed[0] && refreshed[0].at].filter(Boolean).map((v) => new Date(v));
  return times.length ? new Date(Math.max(...times.map((d) => d.getTime()))) : null;
}

/** Linhas do read model de leads por dia para a empresa e a data-base (a M9-D631 acrescenta os de estágio, desfecho e próxima ação). */
async function loadCrmRows(scope, asOfDate, transaction) {
  const base = { companyId: scope.companyId, from: `${monthOf(asOfDate)}-01`, asOfDate, month: monthOf(asOfDate) };
  const leads = await query(
    `SELECT origin, broker_id::text AS "brokerId", sum(leads)::text AS leads, sum(first_response_count)::text AS answered, sum(first_response_seconds_sum)::text AS seconds
       FROM analytics.${T.leads} WHERE company_id = :companyId AND day >= :from AND day <= :asOfDate GROUP BY origin, broker_id`, base, transaction
  );
  return { leads, month: base.month, from: base.from, snapshotAt: { lead: await latestSnapshotAt(scope.companyId, [T.leads], transaction) } };
}

module.exports = { loadCrmRows, T };
