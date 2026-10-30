'use strict';

const { getMarketingParam } = require('../cadence/marketingParam.service');
const { QUIET_HOURS_KEY } = require('../cadence/cadence.defaults');
const { EXPAND_NAME } = require('./restricao.expand');

const LEMBRETE_CODE = 'RESTRICAO-LEMBRETE';
const EXPIRACAO_CODE = 'RESTRICAO-EXPIRACAO';
const EXPIRED = 'EXPIRED';

/** Texto neutro: nunca o motivo da pendência (restrição de crédito, dívida etc.); os detalhes só no portal autenticado. */
const REMINDER_TEXT = 'Olá! Há uma pendência no seu processo. Acesse o portal para ver os detalhes e resolver.';
const REMINDER_SUBJECT = 'Pendência no seu processo';
const TASK_TITLE = 'Pendência sem resolução';
const TASK_TEXT = 'A série de lembretes desta pendência expirou sem resolução. Entre em contato com o cliente.';
const DAILY_AT_NINE = '0 9 * * *';

const base = { riskLevel: 'LOW', triggerType: 'SCHEDULE', conditions: [], cooldown: { amount: 1, unit: 'HOURS' }, frequencyCap: { max: 3, windowDays: 7, scope: 'PERSON_CHANNEL_PURPOSE' } };

async function schedule(tenant, transaction, extra) {
  const { timeZone } = await getMarketingParam(QUIET_HOURS_KEY, tenant, transaction);
  return { cron: DAILY_AT_NINE, timeZone, expand: EXPAND_NAME, ...extra };
}

/** Lembrete periódico (M9-D423): tick diário às 9h; uma run por pendência aberta no dia em que os dias corridos desde a abertura são múltiplo do intervalo. Finalidade TRANSACTIONAL. */
async function lembreteDefinition({ ownerUserId, tenant, transaction, templates = {} }) {
  return {
    ...base, code: LEMBRETE_CODE, name: 'Restrição e regularização: lembretes periódicos', ownerUserId,
    triggerConfig: await schedule(tenant, transaction, { phase: 'REMINDER' }),
    conditionsEmptyReason: 'O tick só cria run no dia do lembrete; a pendência aberta e o intervalo vêm dos parâmetros.',
    actions: [{ actionType: 'SEND_MESSAGE', channel: 'AUTO', purpose: 'TRANSACTIONAL', subject: REMINDER_SUBJECT, text: REMINDER_TEXT, ...(templates[0] ? { templateId: templates[0] } : {}) }],
  };
}

/** Expiração (M9-D423): no primeiro tick com os dias da expiração a run cria a tarefa ao responsável e termina BLOCKED EXPIRED (nenhuma mensagem). */
async function expiracaoDefinition({ ownerUserId, tenant, transaction }) {
  return {
    ...base, code: EXPIRACAO_CODE, name: 'Restrição e regularização: expiração da série de lembretes', ownerUserId,
    triggerConfig: await schedule(tenant, transaction, { phase: 'EXPIRATION', blockWith: EXPIRED }),
    conditionsEmptyReason: 'O tick só cria run quando a série expira e ainda não há run EXPIRED da pendência.',
    actions: [{ actionType: 'CREATE_TASK', title: TASK_TITLE, description: TASK_TEXT, assigneeFromEvent: 'responsibleUserId', priority: 'HIGH' }],
  };
}

module.exports = { lembreteDefinition, expiracaoDefinition, LEMBRETE_CODE, EXPIRACAO_CODE, TASK_TITLE, REMINDER_TEXT };
