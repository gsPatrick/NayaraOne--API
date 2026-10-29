'use strict';

/**
 * M9-D615 (3.3) — componentes do read model que não saem do ledger: conciliações pendentes, repasses ao proprietário, comissões e
 * anomalias abertas. Só agregados e contagens (nenhum nome, documento ou id de pessoa entra no read model, 6). Estados do Financeiro:
 * repasse pendente = PENDING ou APPROVED (gerado e ainda não pago); comissão provisionada = parcela PENDING de comissão PENDING/APPROVED
 * (mais a comissão legada sem parcelas); comissão paga = parcela PAID com pagamento no mês da data-base.
 */
const { sequelize } = require('../../../models');
const { iso } = require('./financeHealth.dates');
const { readPendingReconciliations, readOpenAnomalies } = require('./financeHealth.pending');

const one = async (sql, replacements, transaction) => (await sequelize.query(sql, { replacements, transaction }))[0][0];

async function readOtherComponents(companyId, bounds, transaction, { groupId = null, asOf } = {}) {
  const r = { companyId, dayEnd: iso(bounds.dayEnd), horizon30: iso(bounds.horizon30), monthStart: iso(bounds.monthStart), nextMonthStart: iso(bounds.nextMonthStart) };
  const reconciliations = await readPendingReconciliations({ companyId, groupId }, asOf, r.dayEnd, transaction); // M9-D624: contagem, valor, idade e faixas
  const repasses = await one(
    `SELECT COALESCE(SUM(net_amount), 0)::text AS total FROM finance.owner_repasses WHERE company_id = :companyId AND status IN ('PENDING', 'APPROVED')`, r, transaction);
  const provisioned = await one(
    `SELECT (COALESCE((SELECT SUM(i.amount) FROM finance.commission_installments i JOIN finance.commissions c ON c.id = i.commission_id
                        WHERE i.company_id = :companyId AND i.status = 'PENDING' AND c.deleted_at IS NULL AND c.status IN ('PENDING', 'APPROVED')), 0)
          + COALESCE((SELECT SUM(c.total_amount) FROM finance.commissions c
                       WHERE c.company_id = :companyId AND c.deleted_at IS NULL AND c.status IN ('PENDING', 'APPROVED')
                         AND NOT EXISTS (SELECT 1 FROM finance.commission_installments i WHERE i.commission_id = c.id)), 0))::text AS total`, r, transaction);
  const paid = await one(
    `SELECT COALESCE(SUM(i.amount), 0)::text AS total FROM finance.commission_installments i
      WHERE i.company_id = :companyId AND i.status = 'PAID' AND i.paid_at >= :monthStart AND i.paid_at < :nextMonthStart`, r, transaction);
  const unlinked = await one(
    `SELECT COALESCE(SUM(i.amount), 0)::text AS total FROM finance.commission_installments i
      WHERE i.company_id = :companyId AND i.status = 'PENDING' AND i.financial_entry_id IS NULL AND i.due_at < :horizon30`, r, transaction);
  const anomalies = await readOpenAnomalies({ companyId, groupId }, transaction);
  return {
    reconciliations, anomalies, pendingReconciliations: reconciliations.count, pendingOwnerRepasses: repasses.total, provisionedCommissions: provisioned.total,
    paidCommissions: paid.total, commissionsUnlinked30d: unlinked.total, openAnomalies: anomalies.total,
  };
}

/** necessidade para respirar = max(0, vencido a pagar + a pagar em 30 dias + comissões sem lançamento − caixa livre), em decimal exato no banco. */
async function breathingNeed({ overduePayables, payables30d, commissionsUnlinked30d, freeCash }, transaction) {
  const row = await one(
    `SELECT GREATEST(0, CAST(:a AS numeric) + CAST(:b AS numeric) + CAST(:c AS numeric) - CAST(:d AS numeric))::text AS v`,
    { a: overduePayables, b: payables30d, c: commissionsUnlinked30d, d: freeCash }, transaction);
  return row.v;
}

module.exports = { readOtherComponents, breathingNeed };
