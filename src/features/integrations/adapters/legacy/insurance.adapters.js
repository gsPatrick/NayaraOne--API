'use strict';

const { InsuranceAdapter } = require('../../providers/insurance/insurance.port');
const { SandboxInsuranceAdapter } = require('../../../procurement/adapters/InsuranceAdapter');
const { wrapLegacy } = require('../legacyWrap');
const { STATUS, CAPABILITIES_WEBHOOK, WEBHOOK } = require('./insurance.ops');
const { SANDBOX_OPS, findByIdempotencyKey } = require('./insurance.sandbox');

/**
 * insurance-sandbox: cotação, proposta, apólice e status simulados (sem rede). A proposta é idempotente pela chave, aceita falha injetada pela connection e responde à consulta
 * pela chave; o webhook de status da apólice (HMAC-SHA256, cabeçalho x-webhook-signature) entra pela rota única de webhooks.
 */
const InsuranceSandboxContractAdapter = wrapLegacy({
  Port: InsuranceAdapter,
  className: 'InsuranceSandboxContractAdapter',
  code: 'insurance-sandbox',
  capabilities: CAPABILITIES_WEBHOOK,
  makeLegacy: () => new SandboxInsuranceAdapter(),
  mapper: STATUS,
  ops: SANDBOX_OPS,
  idempotentOps: ['propose'],
  lookups: { findByIdempotencyKey },
  ...WEBHOOK,
});

module.exports = { InsuranceSandboxContractAdapter };
