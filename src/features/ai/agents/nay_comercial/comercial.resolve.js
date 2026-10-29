'use strict';

// M9-D034 — qual oportunidade o pedido cita: o `subject` { type: 'crmOpportunity', id }, um UUID no texto ou o nome do cliente.
const { Person, Opportunity } = require('../../../../models');
const { semAcento } = require('../../orchestrator/numbers/decimalText');
const { CLOSED_STAGES } = require('./comercial.data');

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
const SUBJECT_TYPES = new Set(['crmopportunity', 'crm.opportunity', 'opportunity']);
const NAME_MIN = 4;
const SCAN_MAX = 500;

const norm = (t) => semAcento(String(t || '')).toLowerCase().replace(/\s+/g, ' ').trim();

/** `{ id }` quando achou uma oportunidade; `{ ambiguous: [{ id, customerName, stage }] }` com mais de uma; `null` quando nenhuma. */
async function resolveOpportunity(ruleInput, transaction) {
  const subject = ruleInput.subject;
  if (subject && SUBJECT_TYPES.has(String(subject.type).toLowerCase()) && UUID.test(String(subject.id))) return { id: String(subject.id).toLowerCase() };
  const inText = UUID.exec(String(ruleInput.input || ''));
  if (inText) return { id: inText[0].toLowerCase() };
  const text = norm(ruleInput.input);
  const persons = await Person.findAll({ attributes: ['id', 'legalName', 'preferredName'], limit: SCAN_MAX, order: [['created_at', 'DESC']], transaction });
  const named = persons.filter((p) => [p.legalName, p.preferredName].some((n) => norm(n).length >= NAME_MIN && text.includes(norm(n))));
  if (!named.length) return null;
  const opps = await Opportunity.findAll({ where: { personId: named.map((p) => p.id) }, order: [['created_at', 'DESC']], transaction });
  const open = opps.filter((o) => !CLOSED_STAGES.includes(String(o.stage).toUpperCase()));
  const pool = open.length ? open : opps;
  if (!pool.length) return null;
  if (pool.length === 1) return { id: pool[0].id };
  const nameOf = new Map(named.map((p) => [p.id, p.preferredName || p.legalName]));
  return { ambiguous: pool.slice(0, 10).map((o) => ({ id: o.id, customerName: nameOf.get(o.personId), stage: o.stage })) };
}

module.exports = { resolveOpportunity };
