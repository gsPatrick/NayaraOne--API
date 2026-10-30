'use strict';

const { rows, one, shortCode, blocker } = require('./sql');

/** Impacto de cancelar uma ordem de compra (linha 3): valor comprometido, recebimentos já feitos e itens da ordem. */
async function procurementOrder({ id, transaction }) {
  const o = await one(transaction, 'SELECT id, status, committed_amount FROM procurement.purchase_orders WHERE id = :id', { id }, 'Pedido de compra não encontrado.', 'PURCHASE_ORDER_NOT_FOUND');
  const [gr] = await rows(transaction, 'SELECT COUNT(*)::int AS n FROM procurement.goods_receipts WHERE purchase_order_id = :id', { id });
  const blockers = !['OPEN', 'RECEIVED'].includes(o.status) ? [blocker('ORDER_NOT_CANCELLABLE', `a ordem está com situação ${o.status} e não pode ser cancelada`)] : [];
  return {
    code: shortCode('OC', id),
    label: `Ordem ${shortCode('OC', id)}`,
    impact: { counts: { orders: 1, goodsReceipts: gr.n }, totalAmountCents: Math.round(Number(o.committed_amount) * 100), blockers, items: [{ type: 'PURCHASE_ORDER', id: o.id, label: `Ordem ${shortCode('OC', id)}`, amount: o.committed_amount, status: o.status }] },
  };
}

module.exports = { procurementOrder };
