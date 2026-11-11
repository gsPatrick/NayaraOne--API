'use strict';

const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const { BLOCK_REASONS } = require('../automations/policy.reasons');

/** Motivos que só o disparo da campanha produz (fora do dicionário do canSend). */
const CAMPAIGN_REASONS = Object.freeze({
  PURPOSE_UNKNOWN: { code: 'MKT_PURPOSE_UNKNOWN', message: 'A finalidade do público da campanha não está configurada.' },
  CANSEND_ERROR: { code: 'MKT_CANSEND_ERROR', message: 'Não foi possível conferir se o envio era permitido; por segurança, nada foi enviado.' },
  KILL_SWITCH: { code: 'MKT_KILL_SWITCH_ACTIVE', message: 'O kill switch do Marketing está ativo.' },
  NOT_ALLOWED: { code: 'MKT_SEND_NOT_ALLOWED', message: 'O envio não foi permitido.' },
});

const infoOf = (reason) => BLOCK_REASONS[reason] || CAMPAIGN_REASONS[reason] || CAMPAIGN_REASONS.NOT_ALLOWED;

/**
 * Destinatário da campanha barrado pelo canSend (opt-out, supressão, sem consentimento, sem endereço, limite, política do canal):
 * a mensagem não sai e o bloqueio fica na trilha, com a MESMA ação do envio avulso (`marketing.message.blocked` sobre a pessoa,
 * M9-D429), para que quem confere a ficha do contato veja que a mensagem gerada pela campanha ficou BLOCKED e por quê (DI-M9R-2).
 * Grava uma vez por entrega: o chamador só audita quando a linha de entrega acabou de ser criada (replay não duplica).
 */
function auditBlockedRecipient({ tenant, campaign, step, personId, actionKey, reason, deliveryId }, transaction) {
  const info = infoOf(reason);
  return registrarAuditoria({
    groupId: tenant.groupId, companyId: tenant.companyId, actorUserId: null, action: 'marketing.message.blocked', entityType: 'Person', entityId: personId,
    beforeJson: null,
    afterJson: {
      origin: 'CAMPAIGN_STEP', campaignId: campaign.id, campaignCode: campaign.code, stepId: step.id, stepNo: step.step_no, channel: step.channel,
      deliveryId, deliveryStatus: 'BLOCKED', reason, code: info.code, actionKey, sent: false,
    },
    reason: `Mensagem de ${step.channel} da campanha ${campaign.code} (etapa ${step.step_no}) não enviada: ${info.message}`,
  }, transaction);
}

module.exports = { auditBlockedRecipient, CAMPAIGN_REASONS };
