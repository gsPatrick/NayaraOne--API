'use strict';

/**
 * Provedor bancário SANDBOX (simulação) atrás da porta do Guia M4 §6 (infrastructure/bank/bank-adapter.port.js).
 * Nunca é apresentado como banco real: a confirmação vinda daqui é gravada como SANDBOX_CONFIRMED.
 */

// M9-D237: o sandbox lembra as ordens recebidas por chave de idempotência, como um banco de verdade, para a reconciliação do envio incerto (D215) achar a ordem sem reenviá-la.
const RECEIVED_ORDERS = new Map();
const MAX_REMEMBERED_ORDERS = 2000;

class SandboxBankAdapter {
  constructor() {
    // B5 (revisão independente): confirmação vinda daqui é gravada como SANDBOX_CONFIRMED.
    this.isSandbox = true;
  }

  async submitPayment(req) {
    const externalId = `sandbox-${req.idempotencyKey || Date.now()}`;
    if (req.idempotencyKey) {
      if (RECEIVED_ORDERS.size >= MAX_REMEMBERED_ORDERS) RECEIVED_ORDERS.delete(RECEIVED_ORDERS.keys().next().value);
      RECEIVED_ORDERS.set(req.idempotencyKey, externalId);
    }
    return { externalId, status: 'PENDING_EXTERNAL', raw: { sandbox: true, req } };
  }

  /** Consulta pela chave de idempotência: a ordem que o banco recebeu com essa chave, ou { found:false }. */
  findByIdempotencyKey(key) {
    const externalId = RECEIVED_ORDERS.get(key);
    return externalId ? { found: true, externalResourceId: externalId, status: 'PENDING_EXTERNAL' } : { found: false };
  }

  async getPaymentStatus(externalId) {
    // Mock determinístico: toda consulta em sandbox confirma — suficiente pra testar o fluxo
    // completo (submit -> status -> confirm -> ledger) sem nenhuma rede real.
    return { externalId, status: 'CONFIRMED', raw: { sandbox: true } };
  }

  async fetchTransactions(_cursor) {
    return { transactions: [], nextCursor: null };
  }
}

module.exports = { SandboxBankAdapter };
