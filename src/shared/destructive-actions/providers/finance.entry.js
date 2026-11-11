'use strict';

const { rows, one, centsSql, shortCode, blocker } = require('./sql');

/** Impacto de estornar um lançamento (linha 2): o valor que volta, os lançamentos filhos ativos e as intenções de pagamento ligadas. */
async function financeEntry({ id, transaction, itemsMax }) {
  const e = await one(transaction, 'SELECT id, status, amount, description, entry_type FROM finance.financial_entries WHERE id = :id', { id }, 'Lançamento financeiro não encontrado.', 'FINANCE_ENTRY_NOT_FOUND');
  const children = await rows(transaction, `SELECT id, amount, status, description FROM finance.financial_entries WHERE (third_party_origin_entry_id = :id OR parent_entry_id = :id) AND status NOT IN ('REVERSED','CANCELLED') ORDER BY created_at LIMIT :limit`, { id, limit: itemsMax });
  const [thirdParty] = await rows(transaction, `SELECT COUNT(*)::int AS n FROM finance.financial_entries WHERE third_party_origin_entry_id = :id AND parent_entry_id IS NULL AND status NOT IN ('REVERSED','CANCELLED')`, { id });
  const [intents] = await rows(transaction, `SELECT COUNT(*)::int AS n FROM finance.payment_intents WHERE financial_entry_id = :id AND status NOT IN ('CANCELLED')`, { id });
  const [kids] = await rows(transaction, `SELECT COUNT(*)::int AS n, ${centsSql('amount')} AS cents FROM finance.financial_entries WHERE (third_party_origin_entry_id = :id OR parent_entry_id = :id) AND status NOT IN ('REVERSED','CANCELLED')`, { id });
  // M4LR (Caderno §6): o valor que volta é o REALIZADO — baixas parciais menos os estornos delas, ou o movimento menos estornos
  // parciais; previsto não realizado não devolve nada (o estorno só anula o previsto, sem ledger).
  const [realized] = await rows(transaction, `SELECT ${centsSql(`CASE WHEN finance.entry_has_settlement_children(e.id) THEN finance.entry_realized_by_children(e.id)
      WHEN e.status = 'SETTLED' AND e.settled_at IS NOT NULL THEN e.amount - COALESCE((SELECT SUM(x.amount) FROM finance.financial_entries x WHERE x.reversal_of_entry_id = e.id), 0)
      ELSE 0 END`)} AS cents FROM finance.financial_entries e WHERE e.id = :id`, { id });
  const blockers = [];
  if (e.status === 'REVERSED') blockers.push(blocker('ENTRY_ALREADY_REVERSED', 'o lançamento já foi estornado'));
  if (e.status === 'CANCELLED') blockers.push(blocker('ENTRY_CANCELLED', 'o lançamento está cancelado e não pode ser estornado'));
  if (thirdParty.n > 0) blockers.push(blocker('THIRD_PARTY_RELEASES', `${thirdParty.n} liberação(ões) de dinheiro de terceiro ainda ativa(s) dependem deste lançamento`));
  return {
    code: shortCode('LAN', id),
    label: e.description || `Lançamento ${shortCode('LAN', id)}`,
    impact: {
      counts: { entries: 1, activeChildEntries: kids.n, paymentIntents: intents.n },
      totalAmountCents: Number(realized.cents),
      blockers,
      items: [{ type: 'ENTRY', id: e.id, label: e.description || 'Lançamento', amount: e.amount }, ...children.map((c) => ({ type: 'CHILD_ENTRY', id: c.id, label: c.description || 'Lançamento filho', amount: c.amount }))],
    },
  };
}

module.exports = { financeEntry };
