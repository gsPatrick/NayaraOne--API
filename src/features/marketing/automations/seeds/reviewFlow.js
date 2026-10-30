'use strict';

const { readReviewParams } = require('../reviews/review.settings');
const { classify } = require('../reviews/review.classify');
const { seedFrequencyCap } = require('./seedCap');

const REVIEW_CODE = 'REVIEW-REQUEST';
const REVIEW_FILTER = 'SATISFACTION_ACTIONABLE';
const REVIEW_TEXT = 'Olá! Sua opinião é muito importante para nós. Conte como foi a sua experiência: {link}';
const REVIEW_SUBJECT = 'Conte como foi a sua experiência';

/** Só interessa a nota que age (positiva ou negativa pelos parâmetros): a do meio não gera run. A nota vem do evento do CRM, inteira de 1 a 5. */
async function actionableFilter(cand, ctx) {
  const params = await readReviewParams(ctx.tenant, ctx.transaction);
  return ['POSITIVE', 'NEGATIVE'].includes(classify((ctx.event.payload || {}).score, params));
}

/**
 * Satisfação registrada pelo CRM (`crm.satisfaction.recorded`): a ação única REQUEST_REVIEW chama o serviço de pedido de avaliação, que decide pela nota: negativa abre a
 * ocorrência antes e não envia nada; positiva pede a avaliação (canal automático, finalidade AVALIACAO, link rastreável). O texto e o assunto são editáveis em nova versão.
 */
async function reviewDefinition({ ownerUserId, templates = {}, tenant, transaction }) {
  return {
    code: REVIEW_CODE, name: 'Satisfação: pedido de avaliação depois do atendimento (ocorrência antes, se negativa)', ownerUserId, riskLevel: 'MEDIUM', triggerType: 'EVENT',
    triggerConfig: { eventType: 'crm.satisfaction.recorded', filter: REVIEW_FILTER },
    conditions: [], conditionsEmptyReason: 'O filtro do gatilho já limita às notas positivas e negativas dos parâmetros; a ocorrência aberta bloqueia o pedido dentro do serviço.',
    actions: [{ actionType: 'REQUEST_REVIEW', channel: 'AUTO', subject: REVIEW_SUBJECT, text: REVIEW_TEXT, ...(templates[0] ? { templateId: templates[0] } : {}) }],
    cooldown: { amount: 1, unit: 'HOURS' }, frequencyCap: await seedFrequencyCap(tenant, transaction),
  };
}

module.exports = { reviewDefinition, actionableFilter, REVIEW_CODE, REVIEW_FILTER };
