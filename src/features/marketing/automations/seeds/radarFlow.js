'use strict';

const { FREQUENCY_CAP_KEY } = require('../cadence/cadence.defaults');
const { getMarketingParam } = require('../cadence/marketingParam.service');
const { RADAR_ACTIVE_FILTER } = require('./radarPorts');

const RADAR_CODE = 'RADAR-NOVO-IMOVEL';
const TASK_TITLE = 'Cliente {nome} tem match com imóvel {codigo}';
const COOLDOWN = Object.freeze({ amount: 1, unit: 'HOURS' }); // o livro não pede limite próprio do Radar: vale o cap global; a menor espera da definição só cumpre o MKT-006
const CAP_SCOPE = 'PERSON_CHANNEL_PURPOSE';

/**
 * Novo imóvel compatível pelo Radar (M9-D421): a cada `radar.matched` o corretor SEMPRE recebe a tarefa e a notificação (sugestão); o cliente só recebe a mensagem se houver OPT_IN
 * de RADAR no canal e o canSend permitir (consentimento ausente ou OPT_OUT: run BLOCKED, só a sugestão). O mesmo imóvel para o mesmo radar nunca repete: a chave da run é
 * `radar:{radarId}:{propertyId}` (dedupeKey). Horário de silêncio adia só a mensagem. O cap é o global (o mesmo número no momento da instalação; o global continua valendo à parte).
 */
async function radarDefinition({ ownerUserId, templates, tenant, transaction }) {
  const global = await getMarketingParam(FREQUENCY_CAP_KEY, tenant, transaction);
  return {
    code: RADAR_CODE, name: 'Radar: novo imóvel compatível', ownerUserId, riskLevel: 'MEDIUM', triggerType: 'EVENT',
    triggerConfig: { eventType: 'radar.matched', filter: RADAR_ACTIVE_FILTER, dedupeKey: 'radar:{radarId}:{propertyId}' },
    conditions: [], conditionsEmptyReason: 'O radar ativo é conferido no filtro do gatilho; cada envio confere consentimento RADAR, silêncio e limite na hora.',
    actions: [
      { actionType: 'CREATE_TASK', title: TASK_TITLE, priority: 'NORMAL', assignee: 'RADAR_BROKER', variablesProvider: 'RADAR_MATCH', stopOnError: false },
      { actionType: 'NOTIFY_USER', title: 'Novo imóvel compatível com o radar de um cliente', body: TASK_TITLE, assignee: 'RADAR_BROKER', variablesProvider: 'RADAR_MATCH', stopOnError: false },
      {
        actionType: 'SEND_MESSAGE', channel: 'OPTED_IN', purpose: 'RADAR', subject: 'Um imóvel que combina com você', text: 'Olá, {primeiro_nome}! Encontramos um imóvel que combina com o que você procura: {resumo_imovel}. Veja os detalhes: {link}',
        variablesProvider: 'RADAR_MATCH', linkProvider: 'RADAR_LINK', ...(templates && templates[2] ? { templateId: templates[2] } : {}), stopOnError: false,
      },
    ],
    cooldown: COOLDOWN, frequencyCap: { max: global.messages, windowDays: global.days, scope: CAP_SCOPE },
  };
}

module.exports = { radarDefinition, RADAR_CODE };
