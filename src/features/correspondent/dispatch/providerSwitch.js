'use strict';

const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');

/** Motivos da troca de provider do caso na contingência (M9-D228): alternativo elegível da política ou fluxo manual depois do prazo da fila. */
const REASONS = Object.freeze({ ALTERNATE: 'CONTINGENCY_ALTERNATE_PROVIDER', MANUAL: 'CONTINGENCY_QUEUE_EXPIRED' });

/** O provider CONTRATADO do caso: o primeiro `from` do histórico de trocas; sem troca, o provider atual. A comissão segue o provider contratado, não o que levou o envio. */
function contractedProviderCode(financingCase) {
  const historico = Array.isArray(financingCase.providerHistory) ? financingCase.providerHistory : [];
  return historico.length ? historico[0].from : financingCase.providerCode;
}

/** A última troca do caso foi por contingência (o status que a promotora informa por fora exige evidência)? */
function switchedByContingency(financingCase) {
  const historico = Array.isArray(financingCase.providerHistory) ? financingCase.providerHistory : [];
  const ultima = historico[historico.length - 1];
  return Boolean(ultima) && Object.values(REASONS).includes(ultima.reason) && financingCase.providerCode === ultima.to;
}

/**
 * Registra a troca de provider do caso (M9-D228 3.3): o provider atual passa a ser o que leva o envio e o ORIGINAL fica no histórico (`provider_history`), com a auditoria antes/depois.
 * A submissão guarda o provider com que nasceu. Devolve true quando houve troca.
 */
async function recordProviderSwitch(financingCase, submission, { toCode, reason, dispatchId = null, actorUserId = null }, transaction) {
  const from = financingCase.providerCode;
  if (!toCode || from === toCode) return false;
  const entrada = { from, to: toCode, at: new Date().toISOString(), reason, dispatchId, submissionId: submission ? submission.id : null };
  const historico = [...(Array.isArray(financingCase.providerHistory) ? financingCase.providerHistory : []), entrada];
  await financingCase.update({ providerCode: toCode, providerHistory: historico }, { transaction });
  await registrarAuditoria({
    groupId: financingCase.groupId, companyId: financingCase.companyId, actorUserId, action: 'correspondent.case.provider_switched', entityType: 'FinancingCase', entityId: financingCase.id,
    beforeJson: { providerCode: from }, afterJson: { providerCode: toCode, reason, dispatchId, history: historico.length },
    reason: `Provider fora do ar: o envio do caso seguiu por "${toCode}". O provider original ("${from}") fica no histórico do caso.`,
  }, transaction);
  return true;
}

module.exports = { REASONS, contractedProviderCode, switchedByContingency, recordProviderSwitch };
