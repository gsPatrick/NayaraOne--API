'use strict';

// Apoio da M9-D615: grava lançamentos e demais fontes do Financeiro por conexão de superusuário (sem FK, só o que o teste precisa) e
// guarda os ids para a limpeza no fim. Banco descartável apenas.
const crypto = require('node:crypto');

const uuid = () => crypto.randomUUID();

const TABLES = ['reconciliations', 'bank_transactions', 'commission_installments', 'commissions', 'owner_repasses', 'anomaly_cases', 'financial_entries'];

async function insert(env, table, tenant, columns) {
  const id = uuid();
  const all = { id, group_id: tenant.groupId, company_id: tenant.companyId, ...columns };
  const names = Object.keys(all);
  await env.admin.transaction(async (transaction) => {
    await env.admin.query("SET LOCAL session_replication_role = 'replica'", { transaction });
    await env.admin.query(`INSERT INTO finance.${table} (${names.map((n) => `"${n}"`).join(', ')}) VALUES (${names.map((n) => `:${n}`).join(', ')})`, { replacements: all, transaction });
  });
  env.created.push({ table, id });
  return id;
}

const entry = (env, tenant, c) => insert(env, 'financial_entries', tenant, {
  entry_type: c.nature === 'RECEIVABLE' ? 'CREDIT' : 'DEBIT', nature: c.nature, amount: c.amount, status: c.status || 'PENDING', due_at: c.due || null, settled_at: c.settled || null,
  is_third_party_funds: Boolean(c.third), result_center_id: c.center || null, competence_month: c.month || null, reversal_of_entry_id: c.reversalOf || null,
});

async function update(env, table, id, set) {
  const names = Object.keys(set);
  await env.admin.query(`UPDATE finance.${table} SET ${names.map((n) => `"${n}" = :${n}`).join(', ')} WHERE id = :id`, { replacements: { ...set, id } });
}

async function cleanup(env) {
  const byTable = new Map();
  for (const { table, id } of env.created) byTable.set(table, [...(byTable.get(table) || []), id]);
  await env.admin.transaction(async (transaction) => {
    await env.admin.query("SET LOCAL session_replication_role = 'replica'", { transaction });
    for (const table of TABLES) {
      const ids = byTable.get(table);
      if (ids && ids.length) await env.admin.query(`DELETE FROM finance.${table} WHERE id IN (:ids)`, { replacements: { ids }, transaction });
    }
    await env.admin.query('DELETE FROM analytics.rm_finance_health WHERE company_id IN (:c)', { replacements: { c: [env.tenantA.companyId, env.tenantB.companyId] }, transaction });
    await env.admin.query('DELETE FROM analytics.rm_finance_sector_margin WHERE company_id IN (:c)', { replacements: { c: [env.tenantA.companyId, env.tenantB.companyId] }, transaction });
    await env.admin.query("DELETE FROM analytics.rm_applied_events WHERE read_model IN ('rm_finance_health', 'rm_finance_sector_margin')", { transaction });
    await env.admin.query("DELETE FROM analytics.rm_stale_aggregates WHERE read_model IN ('rm_finance_health', 'rm_finance_sector_margin')", { transaction });
    await env.admin.query("DELETE FROM analytics.read_model_refreshes WHERE read_model IN ('rm_finance_health', 'rm_finance_sector_margin')", { transaction });
  });
}

module.exports = { insert, entry, update, cleanup, uuid };
