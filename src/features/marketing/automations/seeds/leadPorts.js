'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../../models');
const { readLeadNames, LEAD_ORIGINS_KEY } = require('../leadParams');
const { NO_REPLY_DAYS_KEY } = require('../cadence/cadence.defaults');
const { getMarketingParam } = require('../cadence/marketingParam.service');
const { readRunnerParams } = require('../runner/runner.settings');

/**
 * M9-D420 — o que as automações de entrada do funil registram no runner: o filtro de origem do lead novo, o canal de origem e o canal com consentimento, as variáveis do texto
 * (primeiro nome, mensagem da etapa da cadência, conteúdo aprovado da nutrição) e o responsável da tarefa (dono da carteira). Tudo lido na hora, sem cache.
 */
const q = (sql, replacements, transaction) => sequelize.query(sql, { replacements, transaction, type: QueryTypes.SELECT });

const LEAD_ORIGIN_FILTER = 'LEAD_ORIGIN';
const CHANNEL_OF_ORIGIN = Object.freeze({ WHATSAPP: 'WHATSAPP', EMAIL: 'EMAIL' });
const CONTACT_TYPES = Object.freeze({ WHATSAPP: ['WHATSAPP', 'PHONE'], EMAIL: ['EMAIL'] });

/** Mensagem de acompanhamento por etapa da cadência (posição na lista `marketing.cadencia.sem_retorno_dias`; passando do fim, vale a última). */
const FOLLOW_UP_TEXTS = Object.freeze([
  'Olá, {nome}! Passando para saber se você conseguiu ver as informações que enviamos. Posso ajudar em algo?',
  'Olá, {nome}! Seguimos à sua disposição para tirar dúvidas e combinar uma visita quando for melhor para você.',
  'Olá, {nome}! Esta é a nossa última mensagem sobre o seu interesse. Se ainda quiser conversar, é só responder por aqui.',
]);

const opportunityOf = async (event, tenant, transaction) => {
  const id = event && event.payload && (event.payload.opportunityId || event.payload.id);
  if (!id) return null;
  return (await q('SELECT id, lead_source, owner_user_id FROM crm.opportunities WHERE id = :id AND company_id = :c AND deleted_at IS NULL', { id, c: tenant.companyId }, transaction))[0] || null;
};

/** Filtro do gatilho do lead novo: a origem da oportunidade precisa estar na lista da empresa (padrão: formulário, site, portal e WhatsApp). */
async function leadOriginFilter(cand, ctx) {
  const opportunity = await opportunityOf(ctx.event, ctx.tenant, ctx.transaction);
  if (!opportunity || !opportunity.lead_source) return false;
  return (await readLeadNames(LEAD_ORIGINS_KEY, ctx.tenant, ctx.transaction)).includes(String(opportunity.lead_source).toUpperCase());
}

/** Canal de origem do lead (WhatsApp ou e-mail); outra origem (formulário, site, portal) cai na ordem dos canais automáticos. */
async function originChannel({ event, tenant, transaction }) {
  const opportunity = await opportunityOf(event, tenant, transaction);
  return opportunity && opportunity.lead_source ? CHANNEL_OF_ORIGIN[String(opportunity.lead_source).toUpperCase()] || null : null;
}

/** Primeiro canal da ordem automática em que a pessoa tem contato E o consentimento mais recente da finalidade da ação é OPT_IN; nenhum, null (o canSend recusa depois). */
async function optedInChannel({ def, subject, tenant, transaction }) {
  if (!subject || !def.purpose) return null;
  const { autoChannels } = await readRunnerParams(tenant, transaction);
  for (const channel of autoChannels) {
    const [contact] = await q('SELECT 1 AS ok FROM people.person_contacts WHERE company_id = :c AND person_id = :p AND contact_type IN (:types) AND deleted_at IS NULL LIMIT 1', { c: tenant.companyId, p: subject.id, types: CONTACT_TYPES[channel] }, transaction);
    const [consent] = await q('SELECT status FROM people.communication_consents WHERE company_id = :c AND person_id = :p AND channel = :ch AND purpose = :pu ORDER BY recorded_at DESC LIMIT 1', { c: tenant.companyId, p: subject.id, ch: channel, pu: String(def.purpose).toUpperCase() }, transaction);
    if (contact && consent && consent.status === 'OPT_IN') return channel;
  }
  return null;
}

/** Nome para o texto: o primeiro nome do cadastro (nome de tratamento, senão o nome legal). */
async function nameVariables({ tenant, transaction, personId }) {
  if (!personId) return {};
  const [row] = await q(`SELECT split_part(btrim(COALESCE(NULLIF(btrim(preferred_name), ''), legal_name)), ' ', 1) AS first_name FROM people.persons WHERE id = :p AND company_id = :c AND deleted_at IS NULL`, { p: personId, c: tenant.companyId }, transaction);
  const first = row && row.first_name ? row.first_name : null;
  return first ? { nome: first, primeiro_nome: first, primeiroNome: first } : {};
}

/** Acompanhamento do lead sem retorno: a mensagem da etapa (a etapa vem do evento da agenda), com o nome já preenchido. */
async function followUpVariables(context) {
  const names = await nameVariables(context);
  const step = Number(context.event && context.event.payload && context.event.payload.step);
  if (!names.nome || !Number.isInteger(step) || step < 1) return names;
  const days = await getMarketingParam(NO_REPLY_DAYS_KEY, context.tenant, context.transaction);
  const texts = FOLLOW_UP_TEXTS;
  const text = texts[Math.min(step, texts.length) - 1].split('{nome}').join(names.nome);
  return { ...names, mensagem_etapa: text, mensagemEtapa: text, dias_sem_retorno: days[Math.min(step, days.length) - 1] };
}

/** Dono da carteira: o responsável da oportunidade do evento; sem ele, o da oportunidade mais recente da pessoa; sem nenhum, null (a tarefa vai ao dono da automação). */
async function opportunityOwner({ tenant, transaction, subject, event }) {
  const opportunity = await opportunityOf(event, tenant, transaction);
  if (opportunity && opportunity.owner_user_id) return opportunity.owner_user_id;
  if (!subject) return null;
  const [row] = await q('SELECT owner_user_id FROM crm.opportunities WHERE person_id = :p AND company_id = :c AND owner_user_id IS NOT NULL AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1', { p: subject.id, c: tenant.companyId }, transaction);
  return row ? row.owner_user_id : null;
}

module.exports = { LEAD_ORIGIN_FILTER, leadOriginFilter, originChannel, optedInChannel, nameVariables, followUpVariables, opportunityOwner, FOLLOW_UP_TEXTS };
