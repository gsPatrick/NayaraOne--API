'use strict';

const { recordConsent } = require('../../people/personConsents.service');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const { normalizar } = require('./whatsapp.params');
const { CHANNEL } = require('./whatsapp.consent');

/**
 * Saída por palavra-chave (M9-D230 3.2): a mensagem recebida que, sozinha, é uma das palavras de saída da empresa (PARAR, SAIR, CANCELAR, em qualquer caixa e com pontuação) revoga na hora o
 * consentimento do CANAL inteiro (finalidade ALL): nenhuma mensagem, de marketing ou transacional, sai depois. O cadastro de consentimentos aciona o Marketing (supressão) na mesma transação.
 * Frase que apenas contém a palavra não conta. Devolve true se revogou.
 */
async function applyKeywordOptOut(ctx, { personId, text, message, params }, transaction) {
  if (!personId || !text || !params.optoutKeywords.includes(normalizar(text))) return false;
  await recordConsent(personId, { channel: CHANNEL, purpose: 'ALL', status: 'OPT_OUT' }, null, transaction);
  await registrarAuditoria({
    groupId: ctx.groupId, companyId: ctx.companyId, actorUserId: null, action: 'crm.message.optout_keyword', entityType: 'Message', entityId: message.id,
    afterJson: { personId, channel: CHANNEL, status: 'OPT_OUT' }, reason: 'O contato pediu para sair por palavra-chave: o consentimento do WhatsApp foi revogado.',
  }, transaction);
  return true;
}

module.exports = { applyKeywordOptOut };
