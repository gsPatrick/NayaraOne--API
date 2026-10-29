'use strict';

/**
 * M9-D623 (3.3) — detalhe das comissões do read model financeiro, a partir das parcelas (finance.commission_installments). PROVISIONADA = parcela
 * PENDING de comissão reconhecida (PENDING ou APPROVED, não apagada); PAGA = parcela PAID com data de pagamento (calendário de São Paulo) no mês da
 * data-base. "Corretor" = o beneficiário da comissão quando é usuário ativo; parcela cujo beneficiário não é usuário ativo vai para "Sem corretor"
 * (regra de qualidade do KPI). Parcela paga sem lançamento SETTLED correspondente também é contada (regra de qualidade). Só ids técnicos e somas:
 * nenhum nome entra no read model. Somas em texto decimal, feitas no banco.
 */
const { sequelize } = require('../../../models');
const { iso } = require('./financeHealth.dates');

const rows = async (sql, replacements, transaction) => (await sequelize.query(sql, { replacements, transaction }))[0];
const ACTIVE_BROKER = "(u.id IS NOT NULL AND u.deleted_at IS NULL AND u.status = 'ACTIVE')";
const FROM = `FROM finance.commission_installments i JOIN finance.commissions c ON c.id = i.commission_id LEFT JOIN core.users u ON u.id = c.beneficiary_user_id`;

const asMap = (list, key) => Object.fromEntries(list.map((r) => [r[key], r.total]));

async function summarize(where, replacements, transaction) {
  const base = `${FROM} WHERE i.company_id = :companyId AND ${where}`;
  const [total] = await rows(`SELECT COALESCE(SUM(i.amount), 0)::text AS total, count(*)::int AS n ${base}`, replacements, transaction);
  const byBroker = await rows(`SELECT c.beneficiary_user_id::text AS broker, SUM(i.amount)::text AS total ${base} AND ${ACTIVE_BROKER} GROUP BY 1 ORDER BY 1`, replacements, transaction);
  const byComponent = await rows(`SELECT COALESCE(c.component, 'LEGADO') AS component, SUM(i.amount)::text AS total ${base} GROUP BY 1 ORDER BY 1`, replacements, transaction);
  const [orphan] = await rows(`SELECT COALESCE(SUM(i.amount), 0)::text AS total, count(*)::int AS n ${base} AND NOT ${ACTIVE_BROKER}`, replacements, transaction);
  return { total: total.total, count: total.n, byBroker: asMap(byBroker, 'broker'), byComponent: asMap(byComponent, 'component'), withoutBroker: { count: orphan.n, amount: orphan.total } };
}

async function readCommissionDetails(companyId, bounds, transaction) {
  const r = { companyId, monthStart: iso(bounds.monthStart), nextMonthStart: iso(bounds.nextMonthStart) };
  const provisioned = await summarize("i.status = 'PENDING' AND c.deleted_at IS NULL AND c.status IN ('PENDING', 'APPROVED')", r, transaction);
  const paidWhere = "i.status = 'PAID' AND i.paid_at >= :monthStart AND i.paid_at < :nextMonthStart";
  const paid = await summarize(paidWhere, r, transaction);
  const [unlinked] = await rows(
    `SELECT COALESCE(SUM(i.amount), 0)::text AS total, count(*)::int AS n ${FROM} WHERE i.company_id = :companyId AND ${paidWhere}
        AND NOT EXISTS (SELECT 1 FROM finance.financial_entries e WHERE e.id = i.financial_entry_id AND e.status = 'SETTLED')`, r, transaction);
  return {
    provisioned,
    paid: { ...paid, withoutEntry: { count: unlinked.n, amount: unlinked.total } },
  };
}

module.exports = { readCommissionDetails };
