'use strict';

const { rows, one, centsSql, blocker } = require('./sql');

/** Transições que levam a CANCELLED (mesma tabela do serviço de obras): só delas a obra pode ser cancelada. */
const CANCELLABLE = ['PLANNED', 'BUDGETED', 'READY', 'ACTIVE', 'PAUSED', 'FINAL_INSPECTION'];

/** Impacto de cancelar a obra (linha 7): etapas, orçamento, requisições de material, change orders, pedidos de compra ligados e o orçamento da obra. */
async function constructionProject({ id, transaction, preview, req }) {
  const target = String((req && req.body && req.body.targetStatus) || '').toUpperCase();
  if (!preview && target !== 'CANCELLED') return { skip: true };
  const p = await one(transaction, 'SELECT id, name, code, status, budget_amount FROM construction.projects WHERE id = :id AND deleted_at IS NULL', { id }, 'Obra não encontrada.', 'PROJECT_NOT_FOUND');
  const n = async (sql) => (await rows(transaction, sql, { id }))[0].n;
  const [orders] = await rows(transaction, `SELECT COUNT(*)::int AS n, ${centsSql('o.committed_amount')} AS cents FROM procurement.purchase_orders o JOIN procurement.purchase_requests r ON r.id = o.purchase_request_id WHERE r.project_id = :id AND o.status IN ('OPEN','RECEIVED')`, { id });
  const counts = {
    stages: await n('SELECT COUNT(*)::int AS n FROM construction.project_stages WHERE project_id = :id AND deleted_at IS NULL'),
    budgets: await n('SELECT COUNT(*)::int AS n FROM construction.budgets WHERE project_id = :id AND deleted_at IS NULL'),
    changeOrders: await n('SELECT COUNT(*)::int AS n FROM construction.change_orders WHERE project_id = :id AND deleted_at IS NULL'),
    materialRequests: await n('SELECT COUNT(*)::int AS n FROM construction.material_requests WHERE project_id = :id AND deleted_at IS NULL'),
    openPurchaseOrders: orders.n,
  };
  const blockers = CANCELLABLE.includes(p.status) ? [] : [blocker('PROJECT_NOT_CANCELLABLE', `a obra está em ${p.status} e não pode ser cancelada`)];
  return {
    code: p.code || p.name,
    label: p.name,
    impact: { counts, totalAmountCents: Math.round(Number(p.budget_amount || 0) * 100) + Number(orders.cents), blockers, items: [{ type: 'PROJECT', id: p.id, label: p.name, amount: p.budget_amount }] },
  };
}

module.exports = { constructionProject };
