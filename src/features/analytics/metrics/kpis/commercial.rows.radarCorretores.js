'use strict';

/**
 * M9-D633 — leitura dos read models do Radar e do desempenho por corretor para os três KPIs.
 * Só lê o schema analytics (nunca o OLTP): o valor sai do estado que o worker de read models gravou (M9-D607). O período é o mês de São Paulo da
 * data-base (M9-D606): do dia 1 até ela nos read models por dia, e o mês inteiro nos por mês. A tabela vem de constantes (a varredura de segurança
 * M9-D700 só deixa citar o nome do read model na camada read-models).
 */
const { query, mergeCounts, latestSnapshotAt, baseOf } = require('./commercial.rows.common');
const { READ_MODELS: M } = require('./commercial.defs.radarCorretores');

async function loadRadar(base, transaction) {
  const [sum] = await query(
    `SELECT COALESCE(sum(matches), 0)::text AS matches, COALESCE(sum(sent), 0)::text AS sent, COALESCE(sum(converted_visit_opp), 0)::text AS converted, COALESCE(sum(invalid), 0)::text AS invalid
       FROM analytics.${M.radar} WHERE company_id = :companyId AND day >= :from AND day <= :asOfDate`, base, transaction
  );
  const dayRows = await query(`SELECT by_origin AS o, by_broker AS b FROM analytics.${M.radar} WHERE company_id = :companyId AND day >= :from AND day <= :asOfDate`, base, transaction);
  return { ...sum, byOrigin: mergeCounts(dayRows.map((r) => r.o)), byBroker: mergeCounts(dayRows.map((r) => r.b)) };
}

async function loadBrokers(base, transaction) {
  return query(
    `SELECT broker_id::text AS "brokerId", captured::text AS captured, captured_with_value::text AS "withValue", captured_value_sum::text AS "valueSum", won::text AS won, lost::text AS lost
       FROM analytics.${M.brokers} WHERE company_id = :companyId AND month = :month`, base, transaction
  );
}

/** Linhas dos read models da M9-D633 para a empresa e a data-base. */
async function loadRows(scope, asOfDate, transaction) {
  const base = baseOf(scope, asOfDate);
  const at = (model) => latestSnapshotAt(scope.companyId, model, transaction);
  return {
    radar: await loadRadar(base, transaction), brokers: await loadBrokers(base, transaction),
    snapshotAt: { radar: await at(M.radar), brokers: await at(M.brokers) },
  };
}

module.exports = { loadRows };
