'use strict';

const AppError = require('../../../utils/AppError');
const { assertCaseNotCanceled } = require('../statusMachine');
const { STATUS_LABEL_PT } = require('../correspondentCrmSync.service');

const ACTION_LABEL = {
  document: 'receber documentos',
  requirement: 'alterar o checklist',
  simulation: 'receber simulações',
  appraisal: 'pedir avaliação do imóvel',
};

/**
 * assertCaseAcceptsAction — o caderno só proíbe ação em caso cancelado; as demais etapas em que o caso
 * deixa de aceitar documento, simulação ou avaliação são um parâmetro da empresa (Parâmetros,
 * "ações bloqueadas por etapa"). Cancelado é sempre bloqueado.
 */
async function assertCaseAcceptsAction(financingCase, action, transaction) {
  assertCaseNotCanceled(financingCase);
  const { peekEligibilityConfig } = require('../eligibility.service');
  const config = await peekEligibilityConfig(financingCase.groupId, financingCase.companyId, transaction);
  const blocked = Array.isArray(config.blockedActionCaseStatuses) ? config.blockedActionCaseStatuses : [];
  if (blocked.includes(financingCase.status)) {
    throw AppError.unprocessable(
      `Um caso em "${STATUS_LABEL_PT[financingCase.status] || financingCase.status}" não pode ${ACTION_LABEL[action] || 'receber esta ação'}. A empresa define essas etapas em Parâmetros.`,
      'FINANCING_CASE_STATUS_BLOCKS_ACTION'
    );
  }
}

module.exports = { assertCaseAcceptsAction };
