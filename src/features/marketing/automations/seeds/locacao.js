'use strict';

const { getSetting } = require('../../../settings/settings.service');
const { RENTAL_DAYS_KEY } = require('../cadence/cadence.defaults');
const { LEASE_CADENCE_ON_KEY, LEASE_TYPES_KEY, CADENCE_SEED_DEFAULTS, parseTypes } = require('./cadence.settings');
const { PURPOSE } = require('./posChaves');

const LOCACAO_CODE = 'LOCACAO-CADENCIA';
const LEASE_FILTER = 'LEASE_ACTIVATION';

/** Conteúdo por marco da locação: boas-vindas, boletos e vencimento, vistoria, satisfação e renovação. */
const MARCOS = Object.freeze([
  { subject: 'Boas-vindas à sua locação', text: 'Olá! Boas-vindas à sua nova locação. Estamos à disposição para o que precisar.' },
  { subject: 'Boletos e vencimento da sua locação', text: 'Olá! Um lembrete: seus boletos e a data de vencimento estão no portal. Qualquer dúvida, é só chamar.' },
  { subject: 'Vistoria do seu imóvel', text: 'Olá! Lembrando da vistoria do imóvel: confira se está tudo conforme combinado e nos avise de qualquer diferença.' },
  { subject: 'Conte como está sendo a sua locação', text: 'Olá! Queremos saber como está sendo a sua experiência com a locação. Responda nossa pesquisa de satisfação: {link}', linkProvider: 'SATISFACTION_LINK' },
  { subject: 'Renovação do seu contrato de locação', text: 'Olá! Seu contrato de locação está se aproximando da renovação. Vamos conversar sobre as condições?' },
]);

/** Só interessa o contrato de locação (tipos do parâmetro) e só quando a empresa ligou a cadência de locação (padrão: desligada). */
async function leaseFilter(cand, ctx) {
  const types = parseTypes(await getSetting(LEASE_TYPES_KEY, ctx.tenant, ctx.transaction, CADENCE_SEED_DEFAULTS[LEASE_TYPES_KEY]));
  if (!types.includes(String((ctx.event.payload || {}).contractType || '').toUpperCase())) return false;
  return (await getSetting(LEASE_CADENCE_ON_KEY, ctx.tenant, ctx.transaction, CADENCE_SEED_DEFAULTS[LEASE_CADENCE_ON_KEY])) === true;
}

/** Cadência da locação (M9-D422): gatilho `contract.activated` do contrato de locação (o livro: lease.started), mensagens nos dias do parâmetro a partir do início do contrato. */
async function locacaoDefinition({ ownerUserId, templates = {} }) {
  return {
    code: LOCACAO_CODE, name: 'Locação: cadência de relacionamento depois do início do contrato', ownerUserId, riskLevel: 'LOW', triggerType: 'EVENT',
    triggerConfig: { eventType: 'contract.activated', filter: LEASE_FILTER, dedupeKey: '{id}', requireActiveContract: true, requireNoOpenOccurrence: true },
    conditions: [], conditionsEmptyReason: 'O filtro do gatilho já limita a contratos de locação com a cadência ligada pela empresa.',
    actions: MARCOS.map((marco, index) => ({
      actionType: 'SEND_MESSAGE', channel: 'AUTO', purpose: PURPOSE, subject: marco.subject, text: marco.text, ...(marco.linkProvider ? { linkProvider: marco.linkProvider } : {}),
      ...(templates[index] ? { templateId: templates[index] } : {}), cadence: { code: RENTAL_DAYS_KEY, index, base: 'LEASE_START' }, stopOnError: false,
    })),
    cooldown: { amount: 1, unit: 'HOURS' }, frequencyCap: { max: 3, windowDays: 7, scope: 'PERSON_CHANNEL_PURPOSE' },
  };
}

module.exports = { locacaoDefinition, leaseFilter, LOCACAO_CODE, LEASE_FILTER, MARCOS };
