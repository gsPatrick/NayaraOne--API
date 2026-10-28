'use strict';

const AppError = require('../../../utils/AppError');
const { IntegrationProvider } = require('../../../models');
const { driverForbidden, bankWorkerOnly } = require('./secrets.errors');
const { readSecretParams } = require('./secretParams');

/** Regras da credencial bancária (M9-D202 regra 5) e das finalidades de leitura. */
const PURPOSES = Object.freeze(['dispatch', 'webhook', 'test-connection', 'rotation', 'user-request']);
const BANK_PURPOSES = Object.freeze(['dispatch', 'webhook', 'test-connection', 'rotation']);

const isBank = (domain) => domain === 'BANK';

async function domainOf(connection, transaction) {
  const provider = await IntegrationProvider.findByPk(connection.providerCode, { transaction });
  return provider ? provider.domain : null;
}

function assertPurposeAllowed(domain, purpose) {
  if (!PURPOSES.includes(purpose)) throw AppError.badRequest(`Finalidade de leitura inválida. Use: ${PURPOSES.join(', ')}.`, 'VALIDATION_ERROR');
  if (isBank(domain) && !BANK_PURPOSES.includes(purpose)) throw bankWorkerOnly();
}

/** Cofre local (arquivo) é proibido para BANK em PRODUÇÃO. */
function assertDriverAllowed({ domain, environment, driver }) {
  if (isBank(domain) && environment === 'PRODUCTION' && driver === 'file-mounted') throw driverForbidden();
}

/** Mudar o segredo de uma connection BANK exige MFA recente, em qualquer ambiente (parâmetro liga/desliga). */
async function exigirMfaSegredoBank(domain, ctx, transaction) {
  if (!isBank(domain)) return;
  const { mfaOnBankChange } = await readSecretParams(ctx, transaction);
  if (!mfaOnBankChange) return;
  const { assertRecentMfa } = require('../../users/mfa.service');
  await assertRecentMfa(ctx.userId, transaction);
}

module.exports = { PURPOSES, BANK_PURPOSES, isBank, domainOf, assertPurposeAllowed, assertDriverAllowed, exigirMfaSegredoBank };
