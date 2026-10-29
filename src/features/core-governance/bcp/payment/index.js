'use strict';

const guard = require('./payment.guard');
const pending = require('./payment.pending');
const { PAYMENT_REFUSALS } = require('./payment.constants');
const { govError } = require('../../governance.errors');

/**
 * Pedido de um só pagamento recusado pela dupla checagem: a recusa vira a resposta HTTP (403 ou 422 do livro). Em lote os itens trazem o erro no corpo (cada operação é tudo ou nada).
 */
function singleRefusal(data) {
  if (!data || !Array.isArray(data.items) || data.items.length !== 1) return null;
  const error = data.items[0].error;
  if (!error || !PAYMENT_REFUSALS.includes(error.code)) return null;
  return govError(error.code === 'GOV_BCP_PAYMENT_SAME_PERSON' ? 403 : 422, error.code, error.message);
}

module.exports = { ...guard, ...pending, singleRefusal };
