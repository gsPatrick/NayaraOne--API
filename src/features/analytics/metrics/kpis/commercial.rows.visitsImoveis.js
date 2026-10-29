'use strict';

/**
 * M9-D632 — leitura dos read models de visitas e propostas, carteira de imóveis e mudanças de preço para os cinco KPIs.
 * Só lê o schema analytics (nunca o OLTP): o valor sai do estado que o worker de read models gravou (M9-D607). O período é o mês de São Paulo da
 * data-base (M9-D606): do dia 1 até ela nos read models por dia, e o mês inteiro nos por mês. A tabela vem de constantes (a varredura de segurança
 * M9-D700 só deixa citar o nome do read model na camada read-models).
 */
const { query, mergeCounts, latestSnapshotAt, baseOf } = require('./commercial.rows.common');
const { READ_MODELS: M } = require('./commercial.defs.visitsImoveis');

async function loadVisitsProposals(base, transaction) {
  const [sum] = await query(
    `SELECT COALESCE(sum(visits_scheduled), 0)::text AS scheduled, COALESCE(sum(visits_done), 0)::text AS done, COALESCE(sum(visits_no_broker), 0)::text AS "visitsNoBroker",
            COALESCE(sum(proposals_sent), 0)::text AS sent, COALESCE(sum(proposals_sent_accepted), 0)::text AS accepted, COALESCE(sum(proposals_sent_rejected), 0)::text AS rejected,
            COALESCE(sum(proposals_sent_expired), 0)::text AS expired, COALESCE(sum(proposals_sent_open), 0)::text AS open, COALESCE(sum(proposals_sent_value), 0)::text AS "valueSent",
            COALESCE(sum(proposals_sent_no_value), 0)::text AS "noValue"
       FROM analytics.${M.visits} WHERE company_id = :companyId AND day >= :from AND day <= :asOfDate`, base, transaction
  );
  const dayRows = await query(`SELECT visits_by_broker AS v, proposals_by_broker AS p FROM analytics.${M.visits} WHERE company_id = :companyId AND day >= :from AND day <= :asOfDate`, base, transaction);
  return { ...sum, visitsByBroker: mergeCounts(dayRows.map((r) => r.v)), proposalsByBroker: mergeCounts(dayRows.map((r) => r.p)) };
}

async function loadPortfolio(base, transaction) {
  const rows = await query(
    `SELECT status, no_sale_days_bucket AS bucket, active_count AS active, sale_count AS sale, rent_count AS rent, sale_published_count AS "salePublished", by_type AS "byType"
       FROM analytics.${M.portfolio} WHERE company_id = :companyId`, base, transaction
  );
  return rows;
}

async function loadPriceChanges(base, transaction) {
  const [sum] = await query(
    `SELECT COALESCE(sum(changes), 0)::text AS changes, COALESCE(sum(with_prior), 0)::text AS "withPrior", COALESCE(sum(change_pct_sum), 0)::text AS "pctSum"
       FROM analytics.${M.prices} WHERE company_id = :companyId AND day >= :from AND day <= :asOfDate`, base, transaction
  );
  const dayRows = await query(`SELECT by_broker AS b FROM analytics.${M.prices} WHERE company_id = :companyId AND day >= :from AND day <= :asOfDate`, base, transaction);
  return { ...sum, byBroker: mergeCounts(dayRows.map((r) => r.b)) };
}

/** Linhas dos read models da M9-D632 para a empresa e a data-base. */
async function loadRows(scope, asOfDate, transaction) {
  const base = baseOf(scope, asOfDate);
  const at = (model) => latestSnapshotAt(scope.companyId, model, transaction);
  return {
    visits: await loadVisitsProposals(base, transaction), portfolio: await loadPortfolio(base, transaction), prices: await loadPriceChanges(base, transaction),
    snapshotAt: { visits: await at(M.visits), portfolio: await at(M.portfolio), prices: await at(M.prices) },
  };
}

module.exports = { loadRows };
