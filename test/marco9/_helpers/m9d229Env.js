'use strict';

// Apoio dos testes da mensageria do CRM (M9-D229, M9-D221, M9-D220): connection de mensageria ATIVA com canal e segredo do webhook, pessoa com WhatsApp, envio pelo serviço do CRM,
// rodada do worker de envios, eventos assinados nos dois formatos (A: HMAC com horário; B: HMAC em base64) e leitura das mensagens. Roda em banco descartável (os testes COMMITAM).
// Quem usa define process.env.PORT ANTES de requerer este arquivo (ele sobe o app de teste).
const crypto = require('node:crypto');
const env = require('./m9d212Env');
const { runDispatchCycle } = require('../../../src/features/integrations/dispatch/worker');
const { dispatchPendingEventsForCompany } = require('../../../src/engines/events/outbox-dispatcher');
const peopleService = require('../../../src/features/people/people.service');
const messaging = require('../../../src/features/crm/messaging');
const { transitionConnection } = require('../../../src/features/integrations/registry/connections.transition');
const store = require('../../../src/features/integrations/providers/messaging/sandbox/messaging.sandbox.store');

const { comTenant, sql, ctxDe, uniqueSuffix } = env;

/** Só uma connection de mensageria ATIVA por vez na empresa; cria a do fornecedor, com o canal do webhook, e a ativa. `config` entra em config_json (falhas e atraso do sandbox). */
async function conectar(tenant, provider = 'messaging-sandbox', { config } = {}) {
  await sql(tenant, "UPDATE integration.connections SET status = 'PAUSED' WHERE company_id = :c AND status = 'ACTIVE' AND provider_code LIKE 'messaging-%'", { c: tenant.companyId });
  const canal = await env.criarCanal(tenant, { provider });
  if (config) await sql(tenant, 'UPDATE integration.connections SET config_json = CAST(:cfg AS jsonb) WHERE id = :id', { id: canal.conn.id, cfg: JSON.stringify(config) });
  await comTenant(tenant, (t) => transitionConnection(canal.conn.id, 'ACTIVE', ctxDe(tenant), t));
  return canal;
}

const pausar = (tenant) => sql(tenant, "UPDATE integration.connections SET status = 'PAUSED' WHERE company_id = :c AND status = 'ACTIVE' AND provider_code LIKE 'messaging-%'", { c: tenant.companyId });

/** Pessoa com o telefone como WhatsApp principal. Devolve { id, phone }. */
async function pessoa(tenant, phone = `+55119${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`) {
  const p = await comTenant(tenant, (t) => peopleService.createPerson({
    groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `QA-M9 Cliente ${uniqueSuffix()}`, contacts: [{ contactType: 'WHATSAPP', value: phone, isPrimary: true }],
  }, tenant.userId, t));
  return { id: p.id, phone };
}

const enviarMensagem = (tenant, input) => comTenant(tenant, (t) => messaging.sendMessage(ctxDe(tenant), input, tenant.userId, t));
const rodarEnvios = (tenant) => runDispatchCycle(ctxDe(tenant));
const entregarEventos = (tenant) => dispatchPendingEventsForCompany({ id: tenant.groupId }, { id: tenant.companyId }, { limit: 1000 });
const mensagem = async (tenant, id) => (await sql(tenant, 'SELECT * FROM crm.messages WHERE id = :id', { id }))[0];
const mensagensDa = (tenant, personId) => sql(tenant, 'SELECT * FROM crm.messages WHERE person_id = :p ORDER BY created_at, id', { p: personId });
const envioDe = async (tenant, id) => (await sql(tenant, 'SELECT * FROM integration.dispatches WHERE id = :id', { id }))[0];
const refrescar = (tenant, messageId) => comTenant(tenant, (t) => messaging.refreshStatus(ctxDe(tenant), messageId, t));

/** Evento do formato B (messaging-alt-sandbox): status e mensagem recebida. */
const statusB = (messageId, state) => ({ event_id: `evt-b-${uniqueSuffix()}`, event_type: 'messages.status', message: { id: messageId, state, ts: Math.floor(Date.now() / 1000) } });
const inboundB = (id, fromNumber, body, profile) => ({ event_id: `evt-b-${uniqueSuffix()}`, event_type: 'messages.inbound', message: { id, from_number: fromNumber, body, ts: Math.floor(Date.now() / 1000) }, ...(profile ? { contact: { profile } } : {}) });
/** Evento do formato A (messaging-sandbox): mensagem recebida. */
const inboundA = (messageId, from, text, name) => ({ id: `evt-${uniqueSuffix()}`, type: 'message.inbound', api_version: 'v1', messageId, from, text, ...(name ? { name } : {}) });

/** POST do formato B: HMAC-SHA256 em base64 do corpo bruto no cabeçalho x-alt-signature. */
function enviarB(canal, obj) {
  const corpo = Buffer.from(JSON.stringify(obj));
  return env.postar(`/v1/webhooks/${canal.provider}/${canal.canal}`, corpo, { 'x-alt-signature': crypto.createHmac('sha256', canal.segredo).update(corpo).digest('base64') });
}
/** POST do evento no formato do fornecedor da connection. */
const postar = (canal, obj) => (canal.provider === 'messaging-alt-sandbox' ? enviarB(canal, obj) : env.enviar(canal, obj));
/** Evento de status no formato do fornecedor da connection. */
const eventoStatus = (canal, messageId, interno) => (canal.provider === 'messaging-alt-sandbox'
  ? statusB(messageId, { SENT: 'sent', DELIVERED: 'delivered', READ: 'seen', FAILED: 'undelivered', QUEUED: 'accepted' }[interno])
  : env.evento({ resourceId: messageId, status: interno }));

module.exports = {
  ...env, conectar, pausar, pessoa, enviarMensagem, rodarEnvios, entregarEventos, mensagem, mensagensDa, envioDe, refrescar, statusB, inboundA, inboundB, enviarB, postar, eventoStatus, store, messaging,
};
