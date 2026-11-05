'use strict';

// Apoio dos testes do runner de automações (M9-D414): fluxo publicado, evento de entrada, pessoa pronta e leitura da run e do outbox. Tudo na transação do teste. Não é teste.
require('../../../src/features/marketing'); // registra as portas do runner (canSend, envio, rascunho)
const env = require('./mktMsgEnv');
const { prepararTenants } = require('../../helpers/marketingExecucao');
const { suppress } = require('../../../src/features/marketing/suppression/suppression.service');
const runner = require('../../../src/features/marketing/automations/runner');

const { q, uid, sha, NOON_SP, HOUR } = env;
const EVENT = 'crm.opportunity.created';
const SEND = (over = {}) => ({ actionType: 'SEND_MESSAGE', channel: 'WHATSAPP', purpose: 'MARKETING', variables: { primeiroNome: 'Maria' }, ...over });
const TASK = (over = {}) => ({ actionType: 'CREATE_TASK', title: 'Ligar para o lead QA-M9', ...over });
/** 22:30 em São Paulo (horário de silêncio padrão 21h às 8h). */
const NIGHT = new Date(NOON_SP.getTime() + 8.5 * HOUR); // dia seguinte ao NOON_SP, 01:30Z
const MORNING = new Date(NOON_SP.getTime() + 18 * HOUR); // dia seguinte ao NOON_SP, 11:00Z (08:00 em São Paulo)

/** Fluxo ACTIVE com a versão PUBLISHED já ligada (a versão publicada é imutável; por isso nasce pronta). `actions` recebe o template oficial quando a ação de envio não traz `templateId`. */
async function publishedFlow(t, tenant, over = {}) {
  const templateId = over.templateId || await env.makeTemplate(t, tenant);
  const actions = (over.actions || [SEND(), TASK()]).map((a) => (a.actionType === 'SEND_MESSAGE' && !('templateId' in a) ? { ...a, templateId } : a)).map((a) => (a.templateId === null ? { ...a, templateId: undefined } : a));
  const flowStatus = over.flowStatus || 'ACTIVE';
  if (over.exclusive !== false) await q(t, "UPDATE marketing.automation_flows SET status = 'PAUSED' WHERE company_id = :c AND status = 'ACTIVE'", { c: tenant.companyId }); // só o fluxo do teste dispara
  const [flow] = await q(t, `INSERT INTO marketing.automation_flows (id, group_id, company_id, code, name, owner_user_id, risk_level, status)
    VALUES (gen_random_uuid(), :g, :c, :code, 'Fluxo QA-M9 runner', :o, 'LOW', :st) RETURNING id`, { g: tenant.groupId, c: tenant.companyId, code: `RUN-${uid().slice(0, 8)}`, o: tenant.userId, st: flowStatus });
  const cfg = { eventType: over.eventType || EVENT, ...(over.triggerConfig || {}) };
  const [version] = await q(t, `INSERT INTO marketing.automation_versions (id, group_id, company_id, flow_id, version_no, trigger_type, trigger_config, conditions, conditions_empty_reason, actions,
      cooldown, frequency_cap, valid_from, valid_until, status, risk_level, content_hash)
    VALUES (gen_random_uuid(), :g, :c, :f, 1, :tt, CAST(:cfg AS jsonb), CAST(:cond AS jsonb), 'QA-M9 sem condição', CAST(:act AS jsonb), CAST(:cd AS jsonb), CAST(:cap AS jsonb), :vf, :vu, :vs, 'LOW', :h) RETURNING id`,
  { g: tenant.groupId, c: tenant.companyId, f: flow.id, tt: over.triggerType || 'EVENT', cfg: JSON.stringify(cfg), cond: JSON.stringify(over.conditions || []), act: JSON.stringify(actions),
    cd: JSON.stringify(over.cooldown || { amount: 1, unit: 'HOURS' }), cap: JSON.stringify(over.frequencyCap || { max: 3, windowDays: 7, scope: 'PERSON_CHANNEL_PURPOSE' }),
    vf: over.validFrom || null, vu: over.validUntil || null, vs: over.versionStatus || 'PUBLISHED', h: sha(uid()) });
  if ((over.versionStatus || 'PUBLISHED') === 'PUBLISHED') await q(t, 'UPDATE marketing.automation_flows SET published_version_id = :v WHERE id = :f RETURNING id', { v: version.id, f: flow.id });
  return { flowId: flow.id, versionId: version.id, templateId, actions };
}

/** Evento de entrada do runner (o que o consumidor do outbox monta). */
const eventFor = (tenant, personId, over = {}) => ({
  eventId: over.eventId || uid(), eventType: over.eventType || EVENT, subject: personId ? { type: 'PERSON', id: personId } : null,
  tenant: { groupId: tenant.groupId, companyId: tenant.companyId }, payload: over.payload || {}, correlationId: over.correlationId || uid(),
});

const run = (t, tenant, event, options = {}) => runner.processEvent(event, t, { now: NOON_SP, mode: 'SANDBOX', ...options });
const runRow = async (t, runId) => (await q(t, 'SELECT * FROM marketing.automation_runs WHERE id = :id', { id: runId }))[0];
const events = (t, runId) => q(t, "SELECT event_type, payload_json FROM integration.outbox_events WHERE aggregate_id = :id AND event_type LIKE 'automation.run.%' ORDER BY occurred_at, id", { id: runId });
const tasksByKey = (t, key) => q(t, 'SELECT id, title, action_key FROM core.tasks WHERE action_key = :k', { k: key });
const messagesOf = (t, personId) => q(t, "SELECT id, status, action_key FROM crm.messages WHERE person_id = :p AND direction = 'OUTBOUND'", { p: personId });
/** Opt-out da pessoa no canal (pelo serviço da supressão, como a tela faria). */
const optOut = (t, tenant, personId, channel = 'WHATSAPP') => suppress({ personId, channel, reason: 'OPT_OUT', source: 'QA-M9' }, tenant, t);
const sendEntry = (row) => row.actions_result.find((a) => a.type === 'SEND_MESSAGE');
const entry = (row, type) => row.actions_result.find((a) => a.type === type);

module.exports = { ...env, optOut, runner, EVENT, SEND, TASK, NIGHT, MORNING, prepararTenants, publishedFlow, eventFor, run, runRow, events, tasksByKey, messagesOf, sendEntry, entry, HOUR };
