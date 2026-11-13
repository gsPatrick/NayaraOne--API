'use strict';

const { toDecimal } = require('./bank.money');

/**
 * Objeto de domínio do envio do pagamento (M9-D237 3.1): o que o outputMapper `bank.submitPayment` (M9-D219) aceita. Valor como texto decimal com 2 casas (nunca
 * float), moeda BRL, forma de pagamento, referência opaca da intenção e o favorecido (nome, documento, conta e chave PIX). Nada de ids de pessoa, de conta nem de lançamento.
 */
function buildPaymentDomainObject(intent, { ownerDocument = null } = {}) {
  const snapshot = intent.snapshotJson || {};
  const favorecido = intent.beneficiarySnapshot || {};
  const objeto = {
    amount: toDecimal(snapshot.amount), currency: 'BRL', paymentMethod: intent.paymentMethod, reference: `PAG-${String(intent.id).slice(0, 8).toUpperCase()}`,
    beneficiary: {
      name: favorecido.name || null, document: ownerDocument, account: favorecido.account || null, pixKey: favorecido.pixKey || null, bankCode: favorecido.bankCode || null, branch: favorecido.branch || null,
    },
  };
  if (snapshot.dueAt) objeto.dueDate = new Date(snapshot.dueAt).toISOString().slice(0, 10);
  if (snapshot.description) objeto.description = snapshot.description;
  return objeto;
}

/** Pedido que as fases do envio carregam (a intenção é relida a cada fase; o conteúdo do envio é montado na fase 2). */
function buildSubmitRequest(intent, extra = {}) {
  return {
    paymentMethod: intent.paymentMethod, idempotencyKey: intent.idempotencyKey, amount: toDecimal(intent.snapshotJson?.amount),
    intentId: intent.id, groupId: intent.groupId, companyId: intent.companyId, ...extra,
  };
}

module.exports = { buildPaymentDomainObject, buildSubmitRequest };
