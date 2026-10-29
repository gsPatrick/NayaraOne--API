'use strict';

// Apoio da M9-D624: recalcula os KPIs "do zero" só com as linhas-fonte do Financeiro (conexão de superusuário), sem usar o read model, o
// worker nem a fórmula. Datas pelo fuso de São Paulo (UTC-3 fixo) feitas na mão; dinheiro em decimal exato (money.js).
const money = require('../../../src/features/analytics/metrics/formulas/money');

const spDate = (value) => new Date(new Date(value).getTime() - 3 * 3600 * 1000).toISOString().slice(0, 10);
const daysBetween = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);

async function reconciliationsFromSource(env, t, asOf, edges = [2, 7]) {
  const [txs] = await env.admin.query('SELECT id, bank_account_id, amount::text AS amount, transaction_date FROM finance.bank_transactions WHERE company_id = :c', { replacements: { c: t.companyId } });
  const [recs] = await env.admin.query('SELECT bank_transaction_id FROM finance.reconciliations WHERE company_id = :c', { replacements: { c: t.companyId } });
  const reconciled = new Set(recs.map((r) => r.bank_transaction_id));
  const pending = txs.filter((x) => !reconciled.has(x.id) && spDate(x.transaction_date) <= asOf);
  const abs = (a) => (String(a).startsWith('-') ? String(a).slice(1) : String(a));
  const bandOf = (age) => (age <= edges[0] ? `0-${edges[0]}` : age <= edges[1] ? `${edges[0] + 1}-${edges[1]}` : `${edges[1] + 1}+`);
  const ages = pending.map((x) => daysBetween(spDate(x.transaction_date), asOf));
  const bands = {};
  const accounts = {};
  pending.forEach((x, i) => {
    bands[bandOf(ages[i])] = (bands[bandOf(ages[i])] || 0) + 1;
    accounts[x.bank_account_id] = (accounts[x.bank_account_id] || 0) + 1;
  });
  return {
    count: String(pending.length), amount: money.money(money.sum(pending.map((x) => abs(x.amount)))), oldestDays: ages.length ? String(Math.max(...ages)) : null, bands, accounts,
  };
}

const CLASS = { LOW: 'BAIXO', MEDIUM: 'MEDIO', HIGH: 'ALTO', CRITICAL: 'ALTO' };
async function anomaliesFromSource(env, t, asOf) {
  const [rows] = await env.admin.query("SELECT risk_level, case_type, created_at FROM finance.anomaly_cases WHERE company_id = :c AND status = 'OPEN'", { replacements: { c: t.companyId } });
  const byRisk = { BAIXO: 0, MEDIO: 0, ALTO: 0, NAO_CLASSIFICADO: 0 };
  const byType = {};
  rows.forEach((r) => { byRisk[CLASS[r.risk_level] || 'NAO_CLASSIFICADO'] += 1; byType[r.case_type] = (byType[r.case_type] || 0) + 1; });
  const ages = rows.map((r) => daysBetween(spDate(r.created_at), asOf));
  return { total: String(rows.length), byRisk, byType, oldestDays: ages.length ? String(Math.max(...ages)) : null };
}

module.exports = { reconciliationsFromSource, anomaliesFromSource, spDate };
