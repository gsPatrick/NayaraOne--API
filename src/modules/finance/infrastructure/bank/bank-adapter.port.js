'use strict';

/**
 * Porta do adapter bancário do Financeiro (Guia M4 §2 infrastructure/bank/bank-adapter.port; §6 "Adapter
 * bancário"): "Cada banco/provider fica atrás desse contrato. Trocar fornecedor não altera PaymentService."
 * Os provedores (sandbox e reais) ficam em ./providers e são escolhidos por ./resolve-bank-adapter.js.
 *
 * Contrato (duck-typed, mesmo estilo de modules/legal/signatures/signature-adapter.port.js):
 *   async submitPayment(req) -> { externalId, status, raw }
 *   async getPaymentStatus(externalId) -> { externalId, status, raw }
 *   async fetchTransactions(cursor) -> { transactions: [...], nextCursor }
 */
const PORT_METHODS = Object.freeze(['submitPayment', 'getPaymentStatus', 'fetchTransactions']);

/** Confere que o provedor cumpre a porta e o devolve como está (mesma instância). */
function assertBankAdapter(adapter) {
  const missing = PORT_METHODS.filter((method) => !adapter || typeof adapter[method] !== 'function');
  if (missing.length) {
    throw new Error(`BANK_ADAPTER_PORT_NOT_IMPLEMENTED: o provedor bancário não implementa ${missing.join(', ')}.`);
  }
  return adapter;
}

module.exports = { PORT_METHODS, assertBankAdapter };
