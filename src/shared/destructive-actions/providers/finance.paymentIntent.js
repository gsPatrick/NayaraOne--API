'use strict';

const { one, shortCode, blocker } = require('./sql');

// Guia M4 §3 (DEC-056): EXECUTING = em envio/enviado ao banco; CONFIRMED = pago; CANCELED = cancelado.
const NOT_CANCELLABLE = ['EXECUTING', 'CONFIRMED', 'CANCELED'];
const LABELS = { EXECUTING: 'já enviado ao banco (em execução)', CONFIRMED: 'já pago', CANCELED: 'já cancelado' };

/** Impacto de cancelar um pagamento (linha 2): valor do lançamento, situação e as razões pelas quais o cancelamento é impedido. */
async function financePaymentIntent({ id, transaction }) {
  const p = await one(
    transaction,
    `SELECT pi.id, pi.status, e.amount, e.description FROM finance.payment_intents pi JOIN finance.financial_entries e ON e.id = pi.financial_entry_id WHERE pi.id = :id`,
    { id }, 'Intenção de pagamento não encontrada.', 'FINANCE_PAYMENT_INTENT_NOT_FOUND'
  );
  const blockers = NOT_CANCELLABLE.includes(p.status) ? [blocker('PAYMENT_NOT_CANCELLABLE', `o pagamento está ${LABELS[p.status]}`)] : [];
  return {
    code: shortCode('PGT', id),
    label: p.description || `Pagamento ${shortCode('PGT', id)}`,
    impact: { counts: { paymentIntents: 1 }, totalAmountCents: Math.round(Number(p.amount) * 100), blockers, items: [{ type: 'PAYMENT_INTENT', id: p.id, label: p.description || 'Pagamento', amount: p.amount, status: p.status }] },
  };
}

module.exports = { financePaymentIntent };
