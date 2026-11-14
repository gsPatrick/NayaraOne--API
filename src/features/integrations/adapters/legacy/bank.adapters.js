'use strict';

const { BankAdapter } = require('../../providers/bank/bank.port');
const { SandboxBankAdapter } = require('../../../../modules/finance/infrastructure/bank/providers/sandbox.provider');
const { getBankLegacyOverride } = require('../../../../modules/finance/infrastructure/bank/resolve-bank-adapter');
const { wrapLegacy } = require('../legacyWrap');
const { STATUS, OPS, CAPABILITIES } = require('./bank.ops');

/**
 * Consulta pela chave de idempotência (M9-D215): o sandbox lembra as ordens recebidas. Adapter de teste sem a consulta e marcado `isSandbox` não tem estado externo: a
 * ausência do registro é a resposta (a ordem pode sair de novo, com a MESMA chave).
 */
const findByIdempotencyKey = async (legacy, req) => {
  if (typeof legacy.findByIdempotencyKey === 'function') return legacy.findByIdempotencyKey(req.idempotencyKey);
  return { found: false };
};

/** bank-sandbox: pagamento simulado (sem rede). O webhook usa o HMAC-SHA256 padrão das integrações. Em teste, `setBankAdapterOverrideForTests` troca o objeto antigo. */
const BankSandboxContractAdapter = wrapLegacy({
  Port: BankAdapter,
  className: 'BankSandboxContractAdapter',
  code: 'bank-sandbox',
  capabilities: CAPABILITIES,
  makeLegacy: () => getBankLegacyOverride() || new SandboxBankAdapter(),
  mapper: STATUS,
  ops: OPS,
  idempotentOps: ['submitPayment'],
  lookups: { findByIdempotencyKey },
});

module.exports = { BankSandboxContractAdapter };
