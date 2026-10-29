'use strict';

const { getSetting } = require('../../../settings/settings.service');

/** Padrões do parametros.csv, usados quando a empresa não configurou. */
const PADROES = Object.freeze({ testTimeoutMs: 10000, humanExtraAttempts: 3, mfaOnProdTest: true, mfaOnRotation: true });

const inteiro = (v, padrao, min) => (Number.isInteger(v) && v >= min ? v : padrao);

async function readActionParams(ctx, transaction) {
  const [timeout, extra, mfaTest, mfaRot] = await Promise.all([
    getSetting('integration.admin.test_connection_timeout_ms', ctx, transaction, PADROES.testTimeoutMs),
    getSetting('integration.retry.human_extra_attempts', ctx, transaction, PADROES.humanExtraAttempts),
    getSetting('integration.admin.mfa_on_prod_test_connection', ctx, transaction, PADROES.mfaOnProdTest),
    getSetting('integration.admin.mfa_on_secret_rotation', ctx, transaction, PADROES.mfaOnRotation),
  ]);
  return {
    testTimeoutMs: inteiro(timeout, PADROES.testTimeoutMs, 1000),
    humanExtraAttempts: inteiro(extra, PADROES.humanExtraAttempts, 1),
    // O valor antigo do dicionário podia vir como texto "true"/"false" (parametros.csv): só o falso explícito desliga.
    mfaOnProdTest: !(mfaTest === false || mfaTest === 'false'),
    mfaOnRotation: !(mfaRot === false || mfaRot === 'false'),
  };
}

module.exports = { readActionParams, PADROES };
