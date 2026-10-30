'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');
const { safeNumber } = require('./money');

const TZ = 'America/Sao_Paulo';
const DAY = `(period_start AT TIME ZONE '${TZ}')::date`;

/**
 * CostReadModel (M9-D860 §3.3): agregado por dia, ambiente, domínio, categoria e tipo. Só conta linha NÃO substituída; ESTIMATED e BILLED ficam
 * em linhas separadas e NENHUMA função daqui devolve total que some os dois. Recalculado por intervalo de dias (serializado por grupo).
 */
async function refresh(tenant, fromDay, toDay, transaction) {
  await sequelize.query("SELECT pg_advisory_xact_lock(hashtext('cost_read_model:' || :groupId))", { transaction, replacements: { groupId: tenant.groupId } });
  await sequelize.query('DELETE FROM governance.cost_read_model WHERE group_id = :groupId AND day BETWEEN :fromDay AND :toDay', { transaction, replacements: { groupId: tenant.groupId, fromDay, toDay } });
  await sequelize.query(
    `INSERT INTO governance.cost_read_model (group_id, company_id, day, environment, domain, category, cost_kind, amount_cents, line_count)
     SELECT group_id, company_id, ${DAY} AS d, environment, domain, category, cost_kind, SUM(amount_cents)::bigint, COUNT(*)::int
       FROM governance.cost_ledger
      WHERE group_id = :groupId AND superseded_by IS NULL AND ${DAY} BETWEEN :fromDay AND :toDay
      GROUP BY group_id, company_id, d, environment, domain, category, cost_kind`,
    { transaction, replacements: { groupId: tenant.groupId, fromDay, toDay } }
  );
}

const dayKey = (date) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);

/** Recalcula os dias que cobrem os períodos informados (Date[]). */
async function refreshForPeriods(tenant, dates, transaction) {
  if (!dates.length) return;
  const keys = dates.map(dayKey).sort();
  await refresh(tenant, keys[0], keys[keys.length - 1], transaction);
}

const toSeries = (rows) => {
  const lines = rows.map((r) => ({ day: r.day, environment: r.environment, domain: r.domain, category: r.category, amountCents: safeNumber(r.amount_cents), lineCount: r.line_count }));
  return { lines, totalCents: lines.reduce((sum, l) => sum + l.amountCents, 0) };
};

/**
 * Consulta de custo: DUAS séries separadas (`estimated` e `billed`), cada uma com o seu total. Nunca há total misto. `includeShared` (só administrador)
 * traz o custo compartilhado (sem empresa); sem ele a consulta devolve só as linhas da empresa.
 */
async function report(tenant, { from, to, environment, domain, category } = {}, { includeShared = false } = {}, transaction) {
  const where = ['group_id = :groupId', 'day BETWEEN :from AND :to', includeShared ? '(company_id IS NULL OR company_id = :companyId)' : 'company_id = :companyId'];
  if (environment) where.push('environment = :environment');
  if (domain) where.push('domain = :domain');
  if (category) where.push('category = :category');
  const rows = await sequelize.query(
    `SELECT to_char(day, 'YYYY-MM-DD') AS day, environment, domain, category, cost_kind, amount_cents, line_count FROM governance.cost_read_model WHERE ${where.join(' AND ')} ORDER BY day, environment, domain, category`,
    { type: QueryTypes.SELECT, transaction, replacements: { groupId: tenant.groupId, companyId: tenant.companyId, from, to, environment, domain, category } }
  );
  return { estimated: toSeries(rows.filter((r) => r.cost_kind === 'ESTIMATED')), billed: toSeries(rows.filter((r) => r.cost_kind === 'BILLED')) };
}

module.exports = { refresh, refreshForPeriods, report, dayKey };
