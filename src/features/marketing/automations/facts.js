'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');
const { COUNTED_MESSAGE_STATUSES } = require('./policy.statuses');

const DAY_MS = 24 * 60 * 60 * 1000;
const q = (sql, replacements, transaction) => sequelize.query(sql, { replacements, transaction, type: QueryTypes.SELECT });

/**
 * Facts da pessoa para as condições do Motor de Regras (M9-D416): só campos seguros do CRM, nunca endereço, documento ou texto
 * livre. `subject` = { type: 'PERSON', id }. Campos: leadStage, leadTemperature, daysSinceContact (null se nunca houve contato),
 * interests (tipos de imóvel dos radares ativos), consents ({ CANAL: { FINALIDADE: 'OPT_IN'|'OPT_OUT' } }, o estado mais recente)
 * e lastProposalValue (número ou null). Sujeito que não é pessoa devolve facts vazios (as regras decidem sobre o vazio).
 */
async function buildAutomationFacts(subject, tenant, transaction, now = new Date()) {
  const empty = { subjectType: subject && subject.type ? subject.type : null, leadStage: null, leadTemperature: null, daysSinceContact: null, interests: [], consents: {}, lastProposalValue: null };
  if (!subject || subject.type !== 'PERSON' || !subject.id) return empty;
  const base = { companyId: tenant.companyId, personId: subject.id };
  const [opportunity] = await q(
    `SELECT stage, temperature FROM crm.opportunities WHERE company_id = :companyId AND person_id = :personId AND deleted_at IS NULL
      ORDER BY created_at DESC LIMIT 1`, base, transaction);
  const [contact] = await q(
    `SELECT max(created_at) AS at FROM crm.messages
      WHERE company_id = :companyId AND person_id = :personId AND (direction = 'INBOUND' OR status IN (:counted))`,
    { ...base, counted: COUNTED_MESSAGE_STATUSES }, transaction);
  const radars = await q(
    `SELECT criteria_json FROM crm.property_radars WHERE company_id = :companyId AND person_id = :personId AND deleted_at IS NULL AND status = 'ACTIVE'`,
    base, transaction);
  const consents = await q(
    `SELECT DISTINCT ON (channel, purpose) channel, purpose, status FROM people.communication_consents
      WHERE company_id = :companyId AND person_id = :personId ORDER BY channel, purpose, recorded_at DESC`, base, transaction);
  const [proposal] = await q(
    `SELECT p.value FROM crm.proposals p JOIN crm.opportunities o ON o.id = p.opportunity_id AND o.company_id = p.company_id
      WHERE p.company_id = :companyId AND o.person_id = :personId AND p.deleted_at IS NULL ORDER BY p.created_at DESC LIMIT 1`, base, transaction);

  const consentMap = {};
  for (const c of consents) { consentMap[c.channel] = { ...(consentMap[c.channel] || {}), [c.purpose]: c.status }; }
  const interests = [...new Set(radars.flatMap((r) => (r.criteria_json && Array.isArray(r.criteria_json.propertyTypes) ? r.criteria_json.propertyTypes : [])).map(String))];
  return {
    ...empty,
    leadStage: opportunity ? opportunity.stage : null,
    leadTemperature: opportunity ? opportunity.temperature : null,
    daysSinceContact: contact && contact.at ? Math.floor((now.getTime() - new Date(contact.at).getTime()) / DAY_MS) : null,
    interests,
    consents: consentMap,
    lastProposalValue: proposal ? Number(proposal.value) : null,
  };
}

module.exports = { buildAutomationFacts };
