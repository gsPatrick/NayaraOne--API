'use strict';

/** Pagamento bancário sobre o registro de integração (Marco 9, M9-D237). Fachada da API pública. */
const { registerResolveHandler } = require('../../integrations/errors');
const constants = require('./bank.constants');
const { ensureBankConnection, configuredProviderKey } = require('./bank.connection');
const { callBankSubmit, dispatchOf, sentResultOf } = require('./bank.dispatch');
const { checkAmount, applyStatusToDispatch, rejectByAmount } = require('./bank.confirm');
const { onMismatchResolved, recordAmountMismatch } = require('./bank.mismatch');
const { migrateBankSecrets, resolveBankWebhookSecret, readBankWebhookSecretFromVault } = require('./bank.secrets');
const { sweepStatements } = require('./bank.statement');
const { reconcileStatements } = require('./bank.reconcile');
const { buildSubmitRequest } = require('./bank.payload');
const { readBankParams, PADROES } = require('./bank.params');
const { BANK_SETTINGS_SCHEMA } = require('./bank.settings');
const { toCents, toDecimal } = require('./bank.money');
const { ensureBankAdaptersRegistered } = require('./bank.boot');

// A resolução humana do erro de valor divergente chega ao Financeiro (decisão REJECT_PAYMENT leva o envio a FAILED).
registerResolveHandler(constants.MISMATCH_CODE, onMismatchResolved);

module.exports = {
  ...constants, ensureBankConnection, configuredProviderKey, callBankSubmit, dispatchOf, sentResultOf, checkAmount, applyStatusToDispatch, rejectByAmount, recordAmountMismatch,
  migrateBankSecrets, resolveBankWebhookSecret, readBankWebhookSecretFromVault, sweepStatements, reconcileStatements, buildSubmitRequest, readBankParams, PADROES, BANK_SETTINGS_SCHEMA, toCents, toDecimal,
  ensureBankAdaptersRegistered,
};
