'use strict';

const { POS_KEYS_DAYS_KEY } = require('../cadence/cadence.defaults');

const POS_CHAVES_CODE = 'POS-CHAVES';
const PURPOSE = 'POS_VENDA';

/** Conteúdo por marco (posição na lista de dias do parâmetro): mudança, pesquisa de satisfação, manutenção e garantia, aniversário da conquista. */
const MARCOS = Object.freeze([
  { subject: 'Tudo certo com a sua mudança?', text: 'Olá! Passando para saber se está tudo certo com a sua mudança. Posso ajudar em algo?' },
  { subject: 'Conte como está sendo a sua experiência', text: 'Olá! Queremos saber como está sendo a sua experiência. Responda nossa pesquisa de satisfação: {link}', linkProvider: 'SATISFACTION_LINK' },
  { subject: 'Dicas de manutenção e garantia do seu imóvel', text: 'Olá! Seguem dicas de manutenção do seu imóvel e lembrete sobre os prazos de garantia. Conte com a gente.' },
  { subject: 'Um ano da sua conquista', text: 'Olá! Hoje faz um ano da sua conquista. Obrigado por confiar em nós. Conte com a gente.' },
]);

/**
 * Pós-chaves (M9-D422): gatilho `keys.delivered` (o livro o chama de contract.keys_delivered; o evento real do Jurídico é keys.delivered). Uma mensagem por marco, com horário
 * calculado pelo parâmetro de cadência, finalidade POS_VENDA para todas, e a conferência do contrato (ativo e sem ocorrência aberta) em cada vencimento.
 */
async function posChavesDefinition({ ownerUserId, templates = {} }) {
  return {
    code: POS_CHAVES_CODE, name: 'Pós-chaves: acompanhamento depois da entrega das chaves', ownerUserId, riskLevel: 'LOW', triggerType: 'EVENT',
    triggerConfig: { eventType: 'keys.delivered', dedupeKey: '{id}', requireActiveContract: true, requireNoOpenOccurrence: true },
    conditions: [], conditionsEmptyReason: 'A cadência vale para toda entrega de chaves; cada envio confere contrato, consentimento e limites na hora.',
    actions: MARCOS.map((marco, index) => ({
      actionType: 'SEND_MESSAGE', channel: 'AUTO', purpose: PURPOSE, subject: marco.subject, text: marco.text, ...(marco.linkProvider ? { linkProvider: marco.linkProvider } : {}),
      ...(templates[index] ? { templateId: templates[index] } : {}), cadence: { code: POS_KEYS_DAYS_KEY, index, base: 'KEYS_DELIVERED' }, stopOnError: false,
    })),
    cooldown: { amount: 1, unit: 'HOURS' }, frequencyCap: { max: 3, windowDays: 7, scope: 'PERSON_CHANNEL_PURPOSE' },
  };
}

module.exports = { posChavesDefinition, POS_CHAVES_CODE, PURPOSE, MARCOS };
