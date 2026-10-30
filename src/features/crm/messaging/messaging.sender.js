'use strict';

const { Op, fn, col, where: sqlWhere } = require('sequelize');
const { sequelize, PersonContact, Opportunity } = require('../../../models');
const { createPerson } = require('../../people/person.service');
const { createOpportunity } = require('../opportunity.service');
const { readMessagingParams } = require('./messaging.params');
const { phoneVariants, digitsOf } = require('./messaging.phone');

const CLOSED_STAGES = ['CLOSED_WON', 'CLOSED_LOST', 'WITHDRAWN'];

/** A pessoa dona do telefone, comparando só os dígitos (o cadastro guarda o número como foi digitado). */
async function findPersonByPhone(e164, countryCode, transaction) {
  const contato = await PersonContact.findOne({
    where: { contactType: { [Op.in]: ['WHATSAPP', 'PHONE'] }, [Op.and]: [sqlWhere(fn('regexp_replace', col('value_normalized'), '\\D', '', 'g'), { [Op.in]: phoneVariants(e164, countryCode) })] },
    order: [['is_primary', 'DESC'], ['created_at', 'ASC']],
    transaction,
  });
  return contato ? contato.personId : null;
}

/** A oportunidade aberta mais recente da pessoa (a conversa continua nela); sem nenhuma aberta, a mensagem fica só na pessoa. */
async function openOpportunityOf(personId, transaction) {
  const todas = await Opportunity.findAll({ where: { personId }, order: [['created_at', 'DESC']], limit: 10, transaction });
  const aberta = todas.find((o) => !CLOSED_STAGES.includes(String(o.stage).toUpperCase()));
  return aberta ? aberta.id : null;
}

/**
 * Quem escreveu (M9-D229 3.2 item 3): pelo telefone acha a pessoa; remetente desconhecido vira lead provisório, pela mesma regra do lead de parceiro: pessoa PF com o telefone
 * como WhatsApp principal e oportunidade Nova com a primeira ação vencendo em `integration.messaging.inbound_lead_prazo_horas`. Duas mensagens simultâneas do mesmo número
 * não criam duas pessoas (trava por empresa e número). Devolve { personId, opportunityId, provisional }.
 */
async function resolveSender(ctx, { from, name }, transaction) {
  const params = await readMessagingParams(ctx, transaction);
  await sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:k))', { replacements: { k: `msg-lead|${ctx.companyId}|${digitsOf(from)}` }, transaction });
  const existente = await findPersonByPhone(from, params.countryCode, transaction);
  if (existente) return { personId: existente, opportunityId: await openOpportunityOf(existente, transaction), provisional: false };
  const pessoa = await createPerson({
    groupId: ctx.groupId, companyId: ctx.companyId, personType: 'PF', legalName: (name && name.trim()) || `Contato WhatsApp ${from}`,
    contacts: [{ contactType: 'WHATSAPP', value: from, isPrimary: true }],
  }, null, transaction);
  const oportunidade = await createOpportunity({
    groupId: ctx.groupId, companyId: ctx.companyId, personId: pessoa.id, stage: 'NEW', nextAction: 'Responder contato recebido por WhatsApp',
    nextActionDueAt: new Date(Date.now() + params.leadDeadlineHours * 3600000),
  }, null, transaction);
  return { personId: pessoa.id, opportunityId: oportunidade.id, provisional: true };
}

module.exports = { resolveSender, findPersonByPhone };
