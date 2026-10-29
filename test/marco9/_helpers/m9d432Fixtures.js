'use strict';

// M9-D432 — apoio dos testes do custo de campanha: campanha em andamento, lançamentos do Financeiro (pelo serviço do Financeiro,
// que é quem grava a referência e o centro de custo) e fotografia do ledger para provar que o Marketing só lê.
const { QueryTypes } = require('sequelize');
const { sequelize, CostCenter } = require('../../../src/models');
const financial = require('../../../src/features/finance/financialEntries.service');
const { createTestCostCenter, uniqueSuffix } = require('../../testHelpers');
const base = require('./m9d431Fixtures');

const q = (t, sql, replacements) => sequelize.query(sql, { transaction: t, replacements, type: QueryTypes.SELECT });

/** Campanha RUNNING com orçamento de R$ 12.000,00 (código QA-M9-...). */
async function runningCampaign(t, tenant, { code, endsAt = '2099-01-01T00:00:00Z' } = {}) {
  const campaign = await base.makeCampaign(t, tenant, code);
  await q(t, "UPDATE marketing.campaigns SET status = 'RUNNING', starts_at = now() - interval '1 day', ends_at = :e, budget_amount = 12000 WHERE id = :id RETURNING id", { e: endsAt, id: campaign.id });
  return campaign;
}

/** Centro de custo; com `code` o código é exatamente esse (igual ao `code` da campanha), sem o prefixo do helper geral. */
async function costCenter(t, tenant, code) {
  if (!code) return createTestCostCenter(tenant, t);
  return CostCenter.create({ groupId: tenant.groupId, companyId: tenant.companyId, code, name: `QA-M9 centro ${code}` }, { transaction: t });
}

/**
 * Despesa do Financeiro. `settle`: já paga (SETTLED; a baixa de PAYABLE exige o fluxo de aprovação do Financeiro, que não é o assunto
 * aqui, então a linha nasce realizada); `ref`: origin_ref; `cc`: centro de custo (padrão: um neutro).
 */
async function expense(t, tenant, { amount, ref = null, cc = null, settle = true } = {}) {
  const center = cc || (await costCenter(t, tenant));
  const entry = await financial.createFinancialEntry({
    groupId: tenant.groupId, companyId: tenant.companyId, entryType: 'DEBIT', nature: 'PAYABLE', amount, costCenterId: center.id,
    originRef: ref, description: `QA-M9 despesa ${uniqueSuffix()}`,
  }, tenant.userId, t);
  if (settle) await q(t, "UPDATE finance.financial_entries SET status = 'SETTLED', settled_at = now() WHERE id = :id RETURNING id", { id: entry.id });
  return entry;
}

/** Baixa parcial como o Financeiro grava: origem PARTIALLY_SETTLED/SETTLED e uma baixa SETTLED apontando para ela (sem o vínculo da campanha). */
async function partialPayment(t, tenant, entry, amount, { last = false } = {}) {
  const [child] = await q(t, `INSERT INTO finance.financial_entries (id, group_id, company_id, cost_center_id, entry_type, nature, amount, status, settled_at, parent_entry_id, competence_month)
    SELECT gen_random_uuid(), group_id, company_id, cost_center_id, entry_type, nature, :a, 'SETTLED', now(), id, competence_month FROM finance.financial_entries WHERE id = :id RETURNING id`, { a: amount, id: entry.id });
  await q(t, "UPDATE finance.financial_entries SET status = :s WHERE id = :id RETURNING id", { s: last ? 'SETTLED' : 'PARTIALLY_SETTLED', id: entry.id });
  return child;
}

/** Fotografia do ledger e do rastro de auditoria do ledger (prova de que nada foi escrito). */
async function ledgerSnapshot(t, tenant) {
  const [rows] = await q(t, `SELECT count(*)::int AS n, md5(string_agg(e::text, '|' ORDER BY e.id)) AS h FROM finance.financial_entries e WHERE e.company_id = :c`, { c: tenant.companyId });
  const [audit] = await q(t, "SELECT count(*)::int AS n FROM audit.audit_log WHERE company_id = :c AND entity_type IN ('FinancialEntry', 'FinancialEntryRow')", { c: tenant.companyId });
  return { rows, audit: audit.n };
}

const costOf = async (t, id) => (await q(t, 'SELECT cost_actual, cost_updated_at, cost_stale FROM marketing.campaigns WHERE id = :id', { id }))[0];

module.exports = { ...base, q, runningCampaign, costCenter, expense, partialPayment, ledgerSnapshot, costOf, financial };
