'use strict';

/** Pagamento bancário sobre o registro de integração (Marco 9, M9-D237). Fachada da API pública. */
const { registerResolveHandler } = require('../../../../features/integrations/errors');
const constants = require('../../infrastructure/bank/hub/bank.constants');
const { ensureBankConnection, configuredProviderKey } = require('../../infrastructure/bank/hub/bank.connection');
const { callBankSubmit, dispatchOf, sentResultOf } = require('../../infrastructure/bank/hub/bank.dispatch');
const { checkAmount, applyStatusToDispatch, rejectByAmount } = require('../../infrastructure/bank/hub/bank.confirm');
const { onMismatchResolved, recordAmountMismatch } = require('../../infrastructure/bank/hub/bank.mismatch');
const { migrateBankSecrets, resolveBankWebhookSecret, readBankWebhookSecretFromVault } = require('../../infrastructure/bank/hub/bank.secrets');
const { sweepStatements } = require('../../infrastructure/bank/hub/bank.statement');
const { reconcileStatements } = require('../../infrastructure/bank/hub/bank.reconcile');
const { buildSubmitRequest } = require('../../infrastructure/bank/hub/bank.payload');
const { readBankParams, PADROES } = require('../../infrastructure/bank/hub/bank.params');
const { BANK_SETTINGS_SCHEMA } = require('../../infrastructure/bank/hub/bank.settings');
const { toCents, toDecimal } = require('../../infrastructure/bank/hub/bank.money');
const { ensureBankAdaptersRegistered } = require('../../infrastructure/bank/hub/bank.boot');
const { installBankReactions } = require('./bank-reactions');
const { installBankContingency } = require('../../infrastructure/bank/hub/bank.contingency');

// A resolução humana do erro de valor divergente chega ao Financeiro (decisão REJECT_PAYMENT leva o envio a FAILED).
registerResolveHandler(constants.MISMATCH_CODE, onMismatchResolved);
// M9-D220: a intenção muda de estado por evento interno do envio (recusa do banco) e a ordem sem resposta conclusiva vai à revisão humana.
installBankReactions();
// M9-D228: banco fora não presume pagamento, consulta antes de reenviar e vira tarefa ao financeiro passado o prazo.
installBankContingency();

module.exports = {
  ...constants, ensureBankConnection, configuredProviderKey, callBankSubmit, dispatchOf, sentResultOf, checkAmount, applyStatusToDispatch, rejectByAmount, recordAmountMismatch,
  migrateBankSecrets, resolveBankWebhookSecret, readBankWebhookSecretFromVault, sweepStatements, reconcileStatements, buildSubmitRequest, readBankParams, PADROES, BANK_SETTINGS_SCHEMA, toCents, toDecimal,
  ensureBankAdaptersRegistered,
};
