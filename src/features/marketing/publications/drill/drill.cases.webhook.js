'use strict';

const crypto = require('node:crypto');
const { ensureSandboxConnection } = require('../../../integrations/registry/connections.ensureSandbox');
const { SandboxChannelAdapter } = require('../adapters/sandbox/SandboxChannelAdapter');
const { CHANNEL_META } = require('../adapters/channels');
const { sendToChannel } = require('../adapters');
const { ingestChannelEvent } = require('../adapters/webhook/webhook.service');
const { runWebhookEventHooks } = require('../adapters/webhook/webhook.hooks');
require('../messaging'); // instala o gancho de status de entrega (M9-D429)
const { scheduledJobs } = require('./drill.fixture');
const { prepare, cycle, posts, seconds } = require('./drill.cycle');
const { jobRow } = require('./drill.fixture');
const { query } = require('./drill.env');

/**
 * M9-D442 — recebimento do canal: assinatura inválida, evento repetido e falha de entrega. Segue a ordem do serviço público (assinatura sobre o corpo bruto ANTES de qualquer
 * gravação; só então a caixa de entrada e os ganchos), na transação do ensaio. O segredo do webhook nasce a cada execução e não existe fora da memória.
 */
const MESSAGE_CHANNELS = Object.freeze(['WHATSAPP', 'EMAIL']);
const sign = (secret, body, at = Math.floor(Date.now() / 1000)) => ({ 'x-signature': `t=${at},v1=${crypto.createHmac('sha256', secret).update(`${at}.`).update(body).digest('hex')}` });
const eventBody = (over) => Buffer.from(JSON.stringify({ id: `drill-${crypto.randomUUID()}`, type: 'message.delivered', ...over }), 'utf8');

async function connectionOf(t, env) {
  const ctx = { groupId: env.tenant.groupId, companyId: env.tenant.companyId, userId: null };
  const c = await ensureSandboxConnection(ctx, { providerCode: CHANNEL_META[env.channel].sandboxProvider, label: 'Failure drill' }, t);
  return { conn: { connectionId: c.id, groupId: env.tenant.groupId, companyId: env.tenant.companyId }, provider: c.providerCode };
}

/** Faz o que o serviço público faz: confere a assinatura e, só se passar, grava e roda os ganchos. Devolve o que aconteceu. */
async function receive(t, env, via, { body, headers, secret }, hooks = runWebhookEventHooks) {
  const adapter = new SandboxChannelAdapter(env.channel, { scope: env.tenant.companyId, webhookSecrets: [secret] });
  let event;
  try {
    event = adapter.parseWebhook(headers, body);
  } catch (err) {
    return { rejected: true, status: err.statusCode, code: err.code };
  }
  const out = await ingestChannelEvent({ conn: via.conn, provider: via.provider, token: env.channel, channel: env.channel, event, headers, rawBody: body }, t, { runHooks: hooks });
  return { rejected: false, ...out };
}

const inboxCount = async (t, provider, eventId) => (await query(t, 'SELECT count(*)::int AS n FROM integration.webhook_inbox WHERE provider_code = :p AND external_event_id = :e', { p: provider, e: eventId }))[0].n;

async function invalidSignature(t, env) {
  await prepare(t, env);
  const via = await connectionOf(t, env);
  const secret = crypto.randomBytes(16).toString('hex');
  const body = eventBody({ resourceId: 'sbx-ref-drill', status: 'DELIVERED' });
  const id = JSON.parse(body.toString('utf8')).id;
  let hooks = 0;
  const count = async (...args) => { hooks += 1; return runWebhookEventHooks(...args); };
  const wrong = await receive(t, env, via, { body, headers: sign(crypto.randomBytes(16).toString('hex'), body), secret }, count);
  const missing = await receive(t, env, via, { body, headers: {}, secret }, count);
  const inbox = await inboxCount(t, via.provider, id);
  const ok = [wrong, missing].every((r) => r.rejected && r.status === 401 && r.code === 'MKT_WEBHOOK_SIGNATURE_INVALID') && inbox === 0 && hooks === 0;
  return { ok, obtained: `assinatura errada: ${wrong.status} ${wrong.code}; sem cabeçalho: ${missing.status} ${missing.code}; linhas na caixa de entrada=${inbox}; ganchos executados=${hooks}` };
}

async function duplicateEvent(t, env) {
  await prepare(t, env);
  const via = await connectionOf(t, env);
  const secret = crypto.randomBytes(16).toString('hex');
  const body = eventBody({ resourceId: 'sbx-ref-drill', status: 'DELIVERED' });
  const id = JSON.parse(body.toString('utf8')).id;
  let hooks = 0;
  const count = async (...args) => { hooks += 1; return runWebhookEventHooks(...args); };
  const headers = sign(secret, body);
  const first = await receive(t, env, via, { body, headers, secret }, count);
  const second = await receive(t, env, via, { body, headers, secret }, count);
  const inbox = await inboxCount(t, via.provider, id);
  const ok = first.status === 'accepted' && second.status === 'duplicate' && inbox === 1 && hooks === 1;
  return { ok, obtained: `1º envio: ${first.status}; 2º envio: ${second.status}; linhas na caixa de entrada=${inbox}; ganchos executados=${hooks}` };
}

/** O que o CRM guarda de contato da pessoa: a oportunidade, as tarefas e as mensagens entregues/lidas. Não pode mudar com uma falha. */
async function crmSnapshot(t, env, personId, opportunityId) {
  const [opp] = await query(t, 'SELECT stage, next_action, next_action_due_at, updated_at FROM crm.opportunities WHERE id = :id', { id: opportunityId });
  const [tasks] = await query(t, 'SELECT count(*)::int AS n FROM core.tasks WHERE company_id = :c AND related_entity_id = :id', { c: env.tenant.companyId, id: opportunityId });
  const [contacts] = await query(t, "SELECT count(*)::int AS n FROM crm.messages WHERE person_id = :p AND (delivery_status IN ('DELIVERED','READ') OR status IN ('DELIVERED','READ'))", { p: personId });
  return JSON.stringify({ opp, tasks: tasks.n, contacts: contacts.n });
}

async function seedCrm(t, env) {
  const [person] = await query(t, "INSERT INTO people.persons (id, group_id, company_id, person_type, legal_name, status) VALUES (gen_random_uuid(), :g, :c, 'PF', 'Failure drill', 'ACTIVE') RETURNING id", { g: env.tenant.groupId, c: env.tenant.companyId });
  const [opp] = await query(t, "INSERT INTO crm.opportunities (id, group_id, company_id, person_id, stage) VALUES (gen_random_uuid(), :g, :c, :p, 'NEW') RETURNING id", { g: env.tenant.groupId, c: env.tenant.companyId, p: person.id });
  return { personId: person.id, opportunityId: opp.id };
}

/** Falha de entrega de MENSAGEM (WhatsApp, e-mail): o webhook diz FAILED e a mensagem fica FAILED, sem contato no CRM. */
async function failedMessage(t, env, crm) {
  const via = await connectionOf(t, env);
  const secret = crypto.randomBytes(16).toString('hex');
  const sent = await sendToChannel(env.channel, { to: '+5571999990000', texto: 'Olá' }, { tenant: env.tenant, transaction: t, idempotencyKey: crypto.createHash('sha256').update(crypto.randomUUID()).digest('hex') });
  await query(t, `INSERT INTO crm.messages (id, group_id, company_id, person_id, channel, direction, author_type, status, delivery_status, purpose, external_message_id, created_at)
    VALUES (gen_random_uuid(), :g, :c, :p, :ch, 'OUTBOUND', 'NAY', 'SENT', 'SENT', 'MARKETING', :ref, now()) RETURNING id`, { g: env.tenant.groupId, c: env.tenant.companyId, p: crm.personId, ch: env.channel, ref: sent.providerRef });
  const body = eventBody({ type: 'message.failed', resourceId: sent.providerRef, status: 'FAILED' });
  const out = await receive(t, env, via, { body, headers: sign(secret, body), secret });
  const [msg] = await query(t, 'SELECT status, delivery_status, failure_reason FROM crm.messages WHERE person_id = :p AND external_message_id = :ref', { p: crm.personId, ref: sent.providerRef });
  return { text: `mensagem ${msg.delivery_status || msg.status} (${msg.failure_reason || 'sem motivo'}), webhook ${out.status}`, applied: out.status === 'accepted' && (msg.delivery_status || msg.status) === 'FAILED' && Boolean(msg.failure_reason) };
}

/** Falha de entrega de PUBLICAÇÃO (site, redes, portal): o canal recusa o post e o job fica FAILED, sem tocar o CRM. */
async function failedPublication(t, env) {
  const s = await scheduledJobs(t, env, env.channel, 1);
  await cycle(t, env, { now: s.now, scenarios: 'REJECTED' });
  await cycle(t, env, { now: seconds(s.now, 3600) });
  const job = await jobRow(t, s.jobs[0]);
  return { text: `publicação ${job.status} (${job.last_error_code}), ${posts(env)} post(s)`, applied: job.status === 'FAILED' && posts(env) === 0 };
}

async function deliveryFailure(t, env) {
  await prepare(t, env);
  const crm = await seedCrm(t, env);
  const before = await crmSnapshot(t, env, crm.personId, crm.opportunityId);
  const failure = MESSAGE_CHANNELS.includes(env.channel) ? await failedMessage(t, env, crm) : await failedPublication(t, env);
  const after = await crmSnapshot(t, env, crm.personId, crm.opportunityId);
  const same = before === after;
  return { ok: failure.applied && same, obtained: `${failure.text}; CRM ${same ? 'sem alteração' : `ALTERADO (${before} -> ${after})`}, sem contato registrado` };
}

module.exports = { invalidSignature, duplicateEvent, deliveryFailure };
