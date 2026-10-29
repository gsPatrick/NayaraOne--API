'use strict';

const { Op } = require('sequelize');
const { IntegrationDispatch } = require('../../../../models');
const AppError = require('../../../../utils/AppError');
const { tenantTx } = require('../worker/tenantTx');
const { view, applyFound, recordOutcome } = require('./reconcile.apply');

const SOURCES = Object.freeze(['WEBHOOK_SIGNED', 'STATUS_QUERY']);

/**
 * resolveDispatchByEvent — um evento do fornecedor (webhook assinado ou consulta de status) ligado ao envio resolve o UNKNOWN sem esperar a
 * consulta (M9-D215 3.2 estratégia 4), e fecha também o SUBMITTED. O evento liga ao envio pela chave de idempotência ou pelo id externo
 * (dentro do mesmo fornecedor). `event.status` é o status JÁ NORMALIZADO pelo adapter (`mapStatus`). Roda sob o lock da linha: se a consulta
 * ou outro evento já confirmou, devolve `{ matched: true, changed: false }` e não faz nada (o primeiro a confirmar vence).
 * `event`: { providerCode, idempotencyKey?, externalResourceId?, externalRequestId?, status, source? }.
 */
async function resolveDispatchByEvent(ctx, event, { now = new Date() } = {}, transactionIn = null) {
  const e = event || {};
  if (!e.providerCode || !e.status || (!e.idempotencyKey && !e.externalResourceId)) {
    throw AppError.unprocessable('O evento precisa do fornecedor, do status e da chave de idempotência ou do id externo.', 'INTEGRATION_EVENT_INVALID');
  }
  const source = SOURCES.includes(e.source) ? e.source : 'WEBHOOK_SIGNED';
  const rodar = async (transaction) => {
    const ligacao = [];
    if (e.idempotencyKey) ligacao.push({ idempotencyKey: e.idempotencyKey });
    if (e.externalResourceId) ligacao.push({ externalResourceId: e.externalResourceId });
    const row = await IntegrationDispatch.findOne({
      where: { companyId: ctx.companyId, providerCode: e.providerCode, [Op.or]: ligacao, status: { [Op.in]: ['UNKNOWN', 'SUBMITTED', 'CONFIRMED'] } },
      order: [['created_at', 'DESC']], transaction, lock: transaction.LOCK.UPDATE,
    });
    if (!row) return { matched: false };
    if (row.status === 'CONFIRMED') return { matched: true, changed: false, status: 'CONFIRMED' };
    const before = view(row);
    const found = { status: String(e.status).toUpperCase(), externalResourceId: e.externalResourceId || row.externalResourceId, externalRequestId: e.externalRequestId || null };
    const r = await applyFound(ctx, row, found, { source }, transaction);
    await recordOutcome(ctx, before, r, { verdict: 'EVENT', trail: [{ strategy: 'WEBHOOK', outcome: 'FOUND', status: found.status }], source }, transaction);
    return { matched: true, changed: r.changed, status: r.state, dispatchId: row.id, now };
  };
  return transactionIn ? rodar(transactionIn) : tenantTx(ctx, rodar);
}

module.exports = { resolveDispatchByEvent, SOURCES };
