'use strict';

// Apoio dos testes M9-D416/M9-D418 (política de envio do Marketing): pessoa com contatos, consentimento, mensagem, run e regra do
// Motor de Regras. Tudo roda dentro da transação do teste (RLS real). Não é teste.
const crypto = require('node:crypto');
const fx = require('../../helpers/m9d412Fixtures');
const { Rule, RuleVersion, RuleScope, RulePublication } = require('../../../src/models');

const { uid, q } = fx;
const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
/** 14:00 em São Paulo (fora do silêncio), segunda-feira. */
const NOON_SP = new Date('2026-11-09T17:00:00Z');

async function addContact(t, tenant, personId, type, value, primary = true) {
  await q(t, `INSERT INTO people.person_contacts (id, group_id, company_id, person_id, contact_type, value_normalized, is_primary)
    VALUES (gen_random_uuid(), :g, :c, :p, :ty, :v, :pr) RETURNING id`, { g: tenant.groupId, c: tenant.companyId, p: personId, ty: type, v: value, pr: primary });
}

async function addConsent(t, tenant, personId, channel, purpose, status, recordedAt = new Date(NOON_SP.getTime() - 30 * DAY)) {
  const [row] = await q(t, `INSERT INTO people.communication_consents (id, group_id, company_id, person_id, channel, purpose, status, recorded_at)
    VALUES (gen_random_uuid(), :g, :c, :p, :ch, :pu, :st, :at) RETURNING id`, { g: tenant.groupId, c: tenant.companyId, p: personId, ch: channel, pu: purpose, st: status, at: recordedAt });
  return row.id;
}

async function addMessage(t, tenant, { personId, channel = 'WHATSAPP', purpose = 'MARKETING', status = 'SENT', at, direction = 'OUTBOUND', actionKey = null }) {
  const [row] = await q(t, `INSERT INTO crm.messages (id, group_id, company_id, person_id, channel, direction, author_type, status, purpose, action_key, created_at)
    VALUES (gen_random_uuid(), :g, :c, :p, :ch, :d, :a, :s, :pu, :k, :at) RETURNING id`,
  { g: tenant.groupId, c: tenant.companyId, p: personId, ch: channel, d: direction, a: direction === 'INBOUND' ? 'CLIENT' : 'NAY', s: status, pu: direction === 'INBOUND' ? null : purpose, k: actionKey, at });
  return row.id;
}

/** Pessoa com WhatsApp e e-mail e OPT_IN em MARKETING/NUTRICAO nos dois canais. */
const uniquePhone = () => `119${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
async function readyPerson(t, tenant, { phone = uniquePhone(), email = `qa-m9-${uid().slice(0, 6)}@exemplo.test`, optIn = ['MARKETING', 'NUTRICAO'] } = {}) {
  const personId = await fx.makePerson(t, tenant);
  if (phone) await addContact(t, tenant, personId, 'WHATSAPP', phone);
  if (email) await addContact(t, tenant, personId, 'EMAIL', email);
  for (const purpose of optIn) {
    if (phone) await addConsent(t, tenant, personId, 'WHATSAPP', purpose, 'OPT_IN');
    if (email) await addConsent(t, tenant, personId, 'EMAIL', purpose, 'OPT_IN');
  }
  return personId;
}

async function makeFlowVersion(t, tenant, { conditions = [], cooldown = { amount: 72, unit: 'HOURS' }, frequencyCap = { max: 3, windowDays: 7, scope: 'PERSON_CHANNEL_PURPOSE' } } = {}) {
  const [flow] = await q(t, `INSERT INTO marketing.automation_flows (id, group_id, company_id, code, name, owner_user_id, risk_level, status)
    VALUES (gen_random_uuid(), :g, :c, :code, 'Fluxo QA-M9', :o, 'LOW', 'ACTIVE') RETURNING id`, { g: tenant.groupId, c: tenant.companyId, code: `F-${uid().slice(0, 8)}`, o: tenant.userId });
  const [version] = await q(t, `INSERT INTO marketing.automation_versions (id, group_id, company_id, flow_id, version_no, trigger_type, trigger_config, conditions, actions,
      cooldown, frequency_cap, status, risk_level, content_hash)
    VALUES (gen_random_uuid(), :g, :c, :f, 1, 'EVENT', '{"eventType":"crm.opportunity.created"}'::jsonb, CAST(:cond AS jsonb), '[{"actionType":"SEND_MESSAGE"}]'::jsonb,
      CAST(:cd AS jsonb), CAST(:cap AS jsonb), 'DRAFT', 'LOW', :h) RETURNING id`,
  { g: tenant.groupId, c: tenant.companyId, f: flow.id, cond: JSON.stringify(conditions), cd: JSON.stringify(cooldown), cap: JSON.stringify(frequencyCap), h: sha(uid()) });
  return { flowId: flow.id, versionId: version.id, conditions, cooldown, frequencyCap };
}

/** Run com ações. `actions` = [{ action_key, action_type, status, channel, purpose, at, reason? }]. */
async function makeRun(t, tenant, { versionId, personId, status = 'COMPLETED', actions = [], nextDueAt = null }) {
  const due = status === 'WAITING' ? (nextDueAt || new Date(NOON_SP.getTime() + DAY)) : nextDueAt;
  const [row] = await q(t, `INSERT INTO marketing.automation_runs (id, group_id, company_id, automation_version_id, trigger_event_id, subject_type, subject_id,
      correlation_id, idempotency_key, status, next_due_at, actions_result)
    VALUES (gen_random_uuid(), :g, :c, :v, 'evt-qa', 'PERSON', :sid, gen_random_uuid(), :k, :st, :due, CAST(:ar AS jsonb)) RETURNING id`,
  { g: tenant.groupId, c: tenant.companyId, v: versionId, sid: personId, k: `run:${uid()}`, st: status, due, ar: JSON.stringify(actions) });
  return row.id;
}

const sendAction = (over = {}) => ({ action_key: sha(uid()), action_type: 'SEND_MESSAGE', status: 'OK', channel: 'WHATSAPP', purpose: 'MARKETING', at: NOON_SP.toISOString(), ...over });

/** Publica no Motor de Regras uma regra GLOBAL da empresa cujo AST é `ast` (ex.: { fact: 'leadStage', op: '==', value: 'NEW' }). */
async function publishRule(t, tenant, code, ast) {
  const base = { groupId: tenant.groupId, companyId: tenant.companyId, createdBy: tenant.userId, updatedBy: tenant.userId };
  const rule = await Rule.create({ ...base, code, name: `Regra QA-M9 ${code}`, description: 'Regra de teste do Marketing.', domain: 'marketing' }, { transaction: t });
  const now = new Date(Date.now() - 60 * 1000);
  const version = await RuleVersion.create({
    ...base, ruleId: rule.id, versionNumber: 1, conditionAstJson: ast, contentHash: sha(JSON.stringify(ast)), actionJson: {}, effectiveFrom: now, effectiveUntil: null,
    status: 'PUBLISHED', publishedByUserId: tenant.userId,
  }, { transaction: t });
  await RuleScope.create({ ...base, ruleVersionId: version.id, scopeType: 'GLOBAL', scopeRefId: null, precedence: 7 }, { transaction: t });
  await RulePublication.create({ ...base, ruleVersionId: version.id, publishedByUserId: tenant.userId, publishedAt: now }, { transaction: t });
  return rule;
}

module.exports = { ...fx, sha, HOUR, DAY, NOON_SP, addContact, addConsent, addMessage, readyPerson, makeFlowVersion, makeRun, sendAction, publishRule };
