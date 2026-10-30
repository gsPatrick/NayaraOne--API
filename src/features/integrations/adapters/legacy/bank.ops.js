'use strict';

const { COMPLETED, mapFrom, verifyOp, hmacVerify } = require('../legacyWrap');

/**
 * Operações e status compartilhados pelos adapters de banco (M9-D237): o objeto antigo (SandboxBankAdapter, SantanderBankAdapter) continua executando; aqui só se traduz
 * o pedido do port `(ctx, request)` para a chamada antiga e a resposta para a saída normalizada. Valor sempre como texto decimal com 2 casas.
 */
const STATUS = mapFrom({
  PENDING_EXTERNAL: 'PENDING', PENDING: 'PENDING', PROCESSING: 'PENDING', REGISTERED: 'PENDING', CONFIRMED: 'PAID', PAID: 'PAID', SETTLED: 'PAID', REJECTED: 'FAILED', FAILED: 'FAILED',
  CANCELLED: 'FAILED', CANCELED: 'FAILED', DENIED: 'FAILED', EXPIRED: 'FAILED', RETURNED: 'RETURNED', COMPLETED, VALID: 'VALID', INVALID: 'INVALID',
});

/** Pedido do port -> pedido antigo do adapter (forma de pagamento, chave de idempotência, valor e favorecido). */
function toLegacyRequest(req, meta) {
  const p = req.payee || {};
  return {
    paymentMethod: req.kind, idempotencyKey: (meta && meta.idempotencyKey) || req.idempotencyKey, amount: req.amount,
    providerPayload: { amount: req.amount, beneficiary: { name: p.name || null, bankCode: p.bankCode || null, branch: p.branch || null, account: p.account || null, pixKey: p.pixKey || null } },
  };
}

/** Valor que o banco informa no status do pagamento (campo do corpo bruto), para a conferência em centavos. */
const amountOf = (raw) => (raw && (raw.amount ?? raw.nominalValue ?? raw.value)) ?? null;

const OPS = {
  submitPayment: async (l, req, self, meta) => { const r = await l.submitPayment(toLegacyRequest(req, meta)); return { externalResourceId: r.externalId, status: self.normalizeStatus(r.status), raw: r.raw }; },
  getPaymentStatus: async (l, req, self) => {
    const r = await l.getPaymentStatus(req.externalResourceId);
    return { externalResourceId: r.externalId, status: self.normalizeStatus(r.status), amount: amountOf(r.raw), raw: r.raw };
  },
  getStatement: async (l, req) => { const r = await l.fetchTransactions(req.cursor); return { status: COMPLETED, transactions: r.transactions || [], nextCursor: r.nextCursor || null, raw: r }; },
  verifyWebhook: verifyOp((l, req) => hmacVerify(req.rawBody, req.headers, req.secret)),
};

const CAPABILITIES = Object.freeze(['submitPayment', 'getPaymentStatus', 'getStatement', 'verifyWebhook']);

module.exports = { STATUS, OPS, CAPABILITIES, toLegacyRequest };
