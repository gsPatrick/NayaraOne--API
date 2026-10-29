'use strict';

const { BankAdapter } = require('../../providers/bank/bank.port');
const { SandboxBankAdapter } = require('../../../finance/adapters/BankAdapter');
const { wrapLegacy, mapFrom, COMPLETED, verifyOp, hmacVerify } = require('../legacyWrap');

/** bank-sandbox: pagamento simulado (sem rede). O webhook usa o HMAC-SHA256 padrão das integrações. */
const BankSandboxContractAdapter = wrapLegacy({
  Port: BankAdapter,
  className: 'BankSandboxContractAdapter',
  code: 'bank-sandbox',
  capabilities: ['submitPayment', 'getPaymentStatus', 'getStatement', 'verifyWebhook'],
  makeLegacy: () => new SandboxBankAdapter(),
  mapper: mapFrom({ PENDING_EXTERNAL: 'PENDING', CONFIRMED: 'PAID', SETTLED: 'PAID', REJECTED: 'FAILED', FAILED: 'FAILED', COMPLETED, VALID: 'VALID', INVALID: 'INVALID' }),
  ops: {
    submitPayment: async (l, req, self) => { const r = await l.submitPayment({ ...req, idempotencyKey: req.idempotencyKey }); return { externalResourceId: r.externalId, status: self.normalizeStatus(r.status), raw: r.raw }; },
    getPaymentStatus: async (l, req, self) => { const r = await l.getPaymentStatus(req.externalResourceId); return { externalResourceId: r.externalId, status: self.normalizeStatus(r.status), raw: r.raw }; },
    getStatement: async (l, req) => { const r = await l.fetchTransactions(req.cursor); return { status: COMPLETED, raw: r }; },
    verifyWebhook: verifyOp((l, req) => hmacVerify(req.rawBody, req.headers, req.secret)),
  },
});

module.exports = { BankSandboxContractAdapter };
