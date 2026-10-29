'use strict';

/**
 * M9-D701 (3.2) — risco da exportação: HIGH se as linhas estimadas passam de `analytics.export.limite_linhas_alto_risco` (é o que define "export
 * massivo"); senão LOW. HIGH exige MFA recente do solicitante (`assertRecentMfa`): sem ele, 403 MFA_STEP_UP_REQUIRED. Os testes provam a recusa pelo
 * serviço, nunca chamando o endpoint de MFA por HTTP.
 */
const { MfaStepUp } = require('../../../models');
const { assertRecentMfa } = require('../../../engines/biExport/exportMfaStepUp');
const { mfaRequired } = require('./export.errors');

const classifyRisk = (rows, limit) => (rows > limit ? 'HIGH' : 'LOW');

/** Id do step-up vigente do usuário, depois de exigir MFA recente. Lança MFA_STEP_UP_REQUIRED (mensagem do livro) ou MFA_REQUIRED_NOT_ENABLED. */
async function requireStepUp(userId, transaction) {
  try {
    await assertRecentMfa(userId, transaction);
  } catch (err) {
    if (err && err.code === 'MFA_STEP_UP_REQUIRED') throw mfaRequired();
    throw err;
  }
  const stepUp = await MfaStepUp.findOne({ where: { userId }, transaction });
  return stepUp.id;
}

module.exports = { classifyRisk, requireStepUp };
