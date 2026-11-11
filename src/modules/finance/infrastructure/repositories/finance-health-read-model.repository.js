'use strict';

/**
 * Leitura do READ MODEL financeiro para a assistente financeira do Caderno §18 (Guia M4 §13: ela "recebe esse read model; não precisa varrer ledger bruto a cada pergunta").
 * O read model já existe no BI (M9-D615): analytics.rm_finance_health (uma linha por empresa e data-base, atualizada pelo worker a cada evento financeiro e
 * pela agenda) e analytics.rm_finance_sector_margin (receita e custo realizados por setor e competência). Aqui só SELECT nessas tabelas (RLS da empresa
 * do contexto) e duas leituras de CADASTRO (contas bancárias em uso, nomes dos setores) — nenhuma soma sobre finance.financial_entries/bank_transactions.
 */
const { sequelize } = require('../../../../models');

const select = async (sql, replacements, transaction) => sequelize.query(sql, { replacements, transaction, type: sequelize.QueryTypes.SELECT });

/** Linha mais recente do rm_finance_health com data-base até `asOfDate` (AAAA-MM-DD), ou null. */
async function findLatestHealth(companyId, asOfDate, transaction) {
  const rows = await select(
    `SELECT as_of_date::text AS as_of_date, source_snapshot_at, refreshed_at, version,
            free_cash::text AS free_cash, third_party_cash::text AS third_party_cash, total_cash::text AS total_cash,
            payables_7d::text AS payables_7d, payables_30d::text AS payables_30d, receivables_7d::text AS receivables_7d, receivables_30d::text AS receivables_30d,
            overdue_payables::text AS overdue_payables, overdue_amount::text AS overdue_amount,
            overdue_amount_in_window_90d::text AS overdue_in_window, receivables_base_90d::text AS receivables_base,
            pending_reconciliations, pending_reconciliations_amount::text AS pending_reconciliations_amount, last_statement_import_date::text AS last_statement_import_date,
            pending_owner_repasses::text AS pending_owner_repasses, provisioned_commissions::text AS provisioned_commissions,
            open_anomalies, open_anomalies_high, breathing_need::text AS breathing_need, overdue_receivables_detail
       FROM analytics.rm_finance_health
      WHERE company_id = :companyId AND as_of_date <= :asOfDate::date
      ORDER BY as_of_date DESC LIMIT 1`,
    { companyId, asOfDate }, transaction);
  return rows[0] || null;
}

/** Receita e custo realizados por setor (centro de resultado) nos meses pedidos, com a data do retrato. */
async function findSectorMargins(companyId, months, transaction) {
  return select(
    `SELECT result_center_id::text AS result_center_id, competence_month, revenue_actual::text AS revenue, cost_actual::text AS cost, source_snapshot_at
       FROM analytics.rm_finance_sector_margin WHERE company_id = :companyId AND competence_month IN (:months)`,
    { companyId, months }, transaction);
}

/** Cadastro: quantas contas bancárias próprias em uso a empresa tem. */
async function countActiveBankAccounts(transaction) {
  const [row] = await select("SELECT COUNT(*)::int AS total FROM finance.bank_accounts WHERE deleted_at IS NULL AND status <> 'BLOCKED'", {}, transaction);
  return row ? row.total : 0;
}

/** Cadastro: nome de cada setor (centro de resultado). */
async function findResultCenterNames(ids, transaction) {
  if (!ids.length) return new Map();
  const rows = await select('SELECT id::text AS id, name FROM finance.result_centers WHERE id IN (:ids)', { ids }, transaction);
  return new Map(rows.map((r) => [r.id, r.name]));
}

module.exports = { findLatestHealth, findSectorMargins, countActiveBankAccounts, findResultCenterNames };
