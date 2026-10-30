'use strict';

const { QUIET_HOURS_KEY, FREQUENCY_CAP_KEY } = require('../cadence/cadence.defaults');
const { getMarketingParam } = require('../cadence/marketingParam.service');
const { LEAD_DEADLINE_KEY, COLD_MAX_KEY, COLD_WINDOW_KEY } = require('../leadParams');
const { ensureContactChannelRule, CONTACT_RULE_CODE } = require('./leadRule');
const { LEAD_ORIGIN_FILTER } = require('./leadPorts');
const { EXPAND_SEM_RETORNO, EXPAND_CLIENTE_FRIO } = require('./leadExpand');

const LEAD_NOVO_CODE = 'LEAD-NOVO';
const SEM_RETORNO_CODE = 'LEAD-SEM-RETORNO';
const CLIENTE_FRIO_CODE = 'LEAD-CLIENTE-FRIO';

/** Cron do livro: sem retorno todo dia às 09:00; cliente frio toda segunda às 09:00 (no fuso da empresa). */
const DAILY_AT_NINE = '0 9 * * *';
const MONDAY_AT_NINE = '0 9 * * 1';
const DAY_COOLDOWN = Object.freeze({ amount: 1, unit: 'DAYS' });
const WEEK_COOLDOWN = Object.freeze({ amount: 7, unit: 'DAYS' });
const CAP_SCOPE = 'PERSON_CHANNEL_PURPOSE';

const withTemplate = (templates, index) => (templates && templates[index] ? { templateId: templates[index] } : {});
/** Cap da versão para as automações de entrada: o mesmo número do cap global da empresa no momento da instalação (o global continua valendo à parte). */
async function versionCap(tenant, transaction) {
  const global = await getMarketingParam(FREQUENCY_CAP_KEY, tenant, transaction);
  return { max: global.messages, windowDays: global.days, scope: CAP_SCOPE };
}
const timeZoneOf = async (tenant, transaction) => (await getMarketingParam(QUIET_HOURS_KEY, tenant, transaction)).timeZone;

/**
 * Lead novo (M9-D420 A): oportunidade criada por formulário, site, portal ou WhatsApp -> confirmação transacional no canal de origem + tarefa ao dono da carteira no prazo do parâmetro.
 * Risco MÉDIO, cooldown de 24 h por pessoa (MKT-006). A tarefa é interna: sai mesmo quando a mensagem é bloqueada.
 */
async function leadNovoDefinition({ ownerUserId, templates, tenant, transaction }) {
  await ensureContactChannelRule({ tenant, actor: ownerUserId }, transaction);
  return {
    code: LEAD_NOVO_CODE, name: 'Lead novo: confirmação e tarefa de contato', ownerUserId, riskLevel: 'MEDIUM', triggerType: 'EVENT',
    triggerConfig: { eventType: 'crm.opportunity.created', filter: LEAD_ORIGIN_FILTER, dedupeKey: '{id}' }, conditions: [CONTACT_RULE_CODE],
    actions: [
      { actionType: 'SEND_MESSAGE', channel: 'ORIGIN', purpose: 'TRANSACTIONAL', subject: 'Recebemos o seu interesse', text: 'Recebemos seu interesse, {primeiro_nome}. Em breve um corretor falará com você.', variablesProvider: 'PERSON', ...withTemplate(templates, 0), stopOnError: false },
      { actionType: 'CREATE_TASK', title: 'Contatar lead novo', priority: 'HIGH', dueInMinutesParam: LEAD_DEADLINE_KEY, assignee: 'OPPORTUNITY_OWNER', stopOnError: false },
    ],
    cooldown: { amount: 24, unit: 'HOURS' }, frequencyCap: await versionCap(tenant, transaction),
  };
}

/**
 * Sem retorno (M9-D420 B): todo dia às 09:00 o tick expande as oportunidades abertas cujo último contato sem resposta tem `marketing.cadencia.sem_retorno_dias` dias; a mensagem da
 * etapa sai como ACOMPANHAMENTO (a pessoa pediu contato: não exige OPT_IN; respeita supressão, silêncio e cap). Resposta do cliente encerra a cadência (a sequência zera).
 */
async function semRetornoDefinition({ ownerUserId, templates, tenant, transaction }) {
  return {
    code: SEM_RETORNO_CODE, name: 'Sem retorno: acompanhamento na cadência configurada', ownerUserId, riskLevel: 'MEDIUM', triggerType: 'SCHEDULE',
    triggerConfig: { cron: DAILY_AT_NINE, timeZone: await timeZoneOf(tenant, transaction), expand: EXPAND_SEM_RETORNO },
    conditions: [], conditionsEmptyReason: 'Os candidatos já saem filtrados da agenda (oportunidade aberta, contato sem resposta no dia da cadência); cada envio confere supressão, silêncio e limite na hora.',
    actions: [{ actionType: 'SEND_MESSAGE', channel: 'AUTO', purpose: 'ACOMPANHAMENTO', subject: 'Seguimos à sua disposição', text: '{mensagem_etapa}', variablesProvider: 'SEM_RETORNO', ...withTemplate(templates, 0), stopOnError: false }],
    cooldown: DAY_COOLDOWN, frequencyCap: await versionCap(tenant, transaction),
  };
}

/**
 * Cliente frio (M9-D420 C): toda segunda às 09:00, nutrição com conteúdo APROVADO para quem está sem interação há `marketing.cliente_frio.dias_inatividade` dias e tem OPT_IN para
 * NUTRICAO. O limite de mensagens na janela móvel tem fonte única nos parâmetros: o cap da versão guarda só os NOMES (`maxParam`, `windowDaysParam`), lidos na hora da avaliação.
 */
async function clienteFrioDefinition({ ownerUserId, templates, tenant, transaction }) {
  return {
    code: CLIENTE_FRIO_CODE, name: 'Cliente frio: nutrição com limite', ownerUserId, riskLevel: 'MEDIUM', triggerType: 'SCHEDULE',
    triggerConfig: { cron: MONDAY_AT_NINE, timeZone: await timeZoneOf(tenant, transaction), expand: EXPAND_CLIENTE_FRIO },
    conditions: [], conditionsEmptyReason: 'Os candidatos já saem filtrados da agenda (sem interação há N dias); o consentimento NUTRICAO e o limite da janela móvel são conferidos no canSend de cada envio.',
    actions: [{ actionType: 'SEND_MESSAGE', channel: 'OPTED_IN', purpose: 'NUTRICAO', subject: '{titulo}', text: '{conteudo}', variablesProvider: 'CLIENTE_FRIO', ...withTemplate(templates, 0), stopOnError: false }],
    cooldown: WEEK_COOLDOWN, frequencyCap: { maxParam: COLD_MAX_KEY, windowDaysParam: COLD_WINDOW_KEY, scope: CAP_SCOPE },
  };
}

module.exports = { leadNovoDefinition, semRetornoDefinition, clienteFrioDefinition, LEAD_NOVO_CODE, SEM_RETORNO_CODE, CLIENTE_FRIO_CODE };
