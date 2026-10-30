'use strict';

/**
 * Objeto antigo duplo do Santander para a suíte de contrato (M9-D237 + M9-D222): a mesma interface do SantanderBankAdapter (submitPayment, getPaymentStatus, fetchTransactions),
 * determinístico e sem rede, mTLS ou credencial. Prova o que é do adapter do contrato (tradução do pedido, status, saída normalizada); o banco real fica para o modo live.
 */
function makeBankDouble() {
  const porChave = new Map();
  return {
    isSandbox: true,
    async submitPayment(req) {
      const chave = req.idempotencyKey || `sem-chave-${porChave.size}`;
      if (!porChave.has(chave)) porChave.set(chave, `santander-contrato-${porChave.size + 1}`);
      return { externalId: porChave.get(chave), status: 'PENDING_EXTERNAL', raw: { amount: req.amount } };
    },
    async getPaymentStatus(externalId) {
      return { externalId, status: 'CONFIRMED', raw: { amount: '150.00', status: 'CONFIRMED' } };
    },
    async fetchTransactions() {
      return { transactions: [], nextCursor: null };
    },
  };
}

module.exports = { makeBankDouble };
