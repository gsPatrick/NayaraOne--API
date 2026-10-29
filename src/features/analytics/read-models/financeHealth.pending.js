'use strict';

/**
 * M9-D624 (3.3) — conciliações pendentes e anomalias abertas do read model financeiro. Conciliação pendente = transação bancária importada
 * (data de calendário de São Paulo até a data-base) sem nenhuma `finance.reconciliations` apontando para ela (a conciliação aprovada é a
 * própria linha de reconciliations: não existe estado intermediário nessa tabela). Anomalia aberta = `anomaly_cases.status = 'OPEN'`;
 * risco ALTO = HIGH e CRITICAL (o mesmo filtro de countOpenHighRiskAnomalies, finance/anomalyCases.service.js); sem nível reconhecido
 * vai para NAO_CLASSIFICADO. Só agregados: nenhum id de pessoa nem descrição entra no read model (o id da conta bancária é id técnico).
 */
const { sequelize } = require('../../../models');
const { readReconciliationBands } = require('./financeKpi.settings');

const SP = "AT TIME ZONE 'America/Sao_Paulo'";
const RISK_CLASS = Object.freeze({ LOW: 'BAIXO', MEDIUM: 'MEDIO', HIGH: 'ALTO', CRITICAL: 'ALTO' });
const RISK_CLASSES = Object.freeze(['BAIXO', 'MEDIO', 'ALTO', 'NAO_CLASSIFICADO']);

const rows = async (sql, replacements, transaction) => (await sequelize.query(sql, { replacements, transaction }))[0];

function bandLabels([a, b]) {
  return [`0-${a}`, `${a + 1}-${b}`, `${b + 1}+`];
}

async function readPendingReconciliations(scope, asOf, dayEnd, transaction) {
  const edges = await readReconciliationBands(scope, transaction);
  const labels = bandLabels(edges);
  const r = { companyId: scope.companyId, asOf, dayEnd, e1: edges[0], e2: edges[1] };
  const cells = await rows(
    `SELECT bt.bank_account_id::text AS account,
            CASE WHEN age <= :e1 THEN 0 WHEN age <= :e2 THEN 1 ELSE 2 END AS band,
            count(*)::int AS n, COALESCE(SUM(abs(bt.amount)), 0)::text AS total, min(bt.d)::text AS oldest
       FROM (SELECT t.id, t.bank_account_id, t.amount, (t.transaction_date ${SP})::date AS d, (CAST(:asOf AS date) - (t.transaction_date ${SP})::date) AS age
               FROM finance.bank_transactions t
              WHERE t.company_id = :companyId AND t.transaction_date < :dayEnd
                AND NOT EXISTS (SELECT 1 FROM finance.reconciliations x WHERE x.bank_transaction_id = t.id)) bt
      GROUP BY 1, 2 ORDER BY 1, 2`, r, transaction);
  const accounts = {};
  let count = 0;
  let oldest = null;
  for (const c of cells) {
    accounts[c.account] = { ...(accounts[c.account] || {}), [labels[c.band]]: { count: c.n, amount: c.total } };
    count += c.n;
    if (!oldest || c.oldest < oldest) oldest = c.oldest;
  }
  const [{ amount }] = await rows(
    `SELECT COALESCE(SUM(abs(t.amount)), 0)::text AS amount FROM finance.bank_transactions t
      WHERE t.company_id = :companyId AND t.transaction_date < :dayEnd AND NOT EXISTS (SELECT 1 FROM finance.reconciliations x WHERE x.bank_transaction_id = t.id)`, r, transaction);
  const [{ last }] = await rows(
    `SELECT max(d)::text AS last FROM (
        SELECT (created_at ${SP})::date AS d FROM finance.bank_statement_imports WHERE company_id = :companyId AND created_at < :dayEnd
        UNION ALL SELECT (created_at ${SP})::date FROM finance.bank_transactions WHERE company_id = :companyId AND created_at < :dayEnd) x`, r, transaction);
  return { count, amount, oldest, byBand: { labels, accounts }, lastImportDate: last };
}

async function readOpenAnomalies(scope, transaction) {
  const found = await rows(
    `SELECT risk_level, case_type, count(*)::int AS n, min((created_at ${SP})::date)::text AS oldest
       FROM finance.anomaly_cases WHERE company_id = :companyId AND status = 'OPEN' GROUP BY 1, 2`, { companyId: scope.companyId }, transaction);
  const byRisk = Object.fromEntries(RISK_CLASSES.map((k) => [k, 0]));
  const byType = {};
  let oldest = null;
  for (const f of found) {
    byRisk[RISK_CLASS[String(f.risk_level).toUpperCase()] || 'NAO_CLASSIFICADO'] += f.n;
    byType[f.case_type] = (byType[f.case_type] || 0) + f.n;
    if (!oldest || f.oldest < oldest) oldest = f.oldest;
  }
  return { total: found.reduce((s, f) => s + f.n, 0), byRisk, byType, oldest };
}

module.exports = { readPendingReconciliations, readOpenAnomalies, RISK_CLASS, RISK_CLASSES, bandLabels };
