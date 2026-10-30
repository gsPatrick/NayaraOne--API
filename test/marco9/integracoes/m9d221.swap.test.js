'use strict';

// Marco 9, M9-D221 — troca de fornecedor sem reescrever o domínio, no banco descartável: a mesma suíte de cenários nos dois adapters de mensageria (mesmo resultado interno), a troca
// no meio da conversa, o envio em voo que termina na connection antiga, a família diferente recusada e a degradação declarada da capability ausente.
process.env.PORT = process.env.M9D221_SWAP_PORT || '21221';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d229Env');
const registry = require('../../../src/features/integrations/registry/registry.service');
const { swapProvider } = require('../../../src/features/integrations/swap');

let tenant;
before(async () => {
  tenant = (await env.carregarTenants()).tenant;
  env.useTempSecretStore();
  await new Promise((resolve) => { setTimeout(resolve, 300); });
});
after(async () => { await env.pausar(tenant); await env.sequelize.close(); process.exit(0); });

const trocar = (from, to) => env.comTenant(tenant, (t) => swapProvider(env.ctxDe(tenant), { fromConnectionId: from, toConnectionId: to }, t));
const statusDe = async (id) => (await env.sql(tenant, 'SELECT status, policy_json FROM integration.connections WHERE id = :id', { id }))[0];

/** Uma conversa completa num fornecedor: envio, aceite, entrega por webhook, webhook repetido, mensagem recebida repetida e mídia. Devolve só o que é INTERNO (nada do formato do fornecedor). */
async function cenario(provider) {
  const canal = await env.conectar(tenant, provider);
  const p = await env.pessoa(tenant);
  const r = await env.enviarMensagem(tenant, { kind: 'text', personId: p.id, to: p.phone, text: 'Olá' });
  const filas = [(await env.mensagem(tenant, r.message.id)).delivery_status];
  await env.rodarEnvios(tenant);
  const aceita = await env.mensagem(tenant, r.message.id);
  filas.push(aceita.delivery_status);
  const evento = env.eventoStatus(canal, aceita.external_message_id, 'DELIVERED');
  await env.postar(canal, evento);
  await env.postar(canal, evento); // webhook repetido
  await env.rodar(tenant);
  await env.rodar(tenant);
  const final = await env.mensagem(tenant, r.message.id);
  filas.push(final.delivery_status);
  const [inbox] = await env.sql(tenant, "SELECT id FROM integration.webhook_inbox WHERE company_id = :c AND provider_code = :p AND resource_ref = :r AND applied IS TRUE", { c: tenant.companyId, p: canal.provider, r: aceita.external_message_id });
  const saidas = (await env.outboxDe(tenant, inbox.id)).map((e) => e.event_type);
  const entrada = canal.provider === 'messaging-alt-sandbox' ? env.inboundB(`in-${env.uniqueSuffix()}`, p.phone.slice(1), 'Tenho interesse') : env.inboundA(`in-${env.uniqueSuffix()}`, p.phone, 'Tenho interesse');
  await env.postar(canal, entrada);
  await env.postar(canal, { ...entrada, ...(canal.provider === 'messaging-alt-sandbox' ? { event_id: `evt-b-${env.uniqueSuffix()}` } : { id: `evt-${env.uniqueSuffix()}` }) }); // mesma mensagem, outro evento
  await env.rodar(tenant);
  const mensagens = await env.mensagensDa(tenant, p.id);
  const envio = await env.envioDe(tenant, r.dispatchId);
  return {
    statusDaMensagem: filas, estadoDoEnvio: envio.status, eventosInternos: saidas, direcoes: mensagens.map((m) => m.direction), textoRecebido: mensagens.find((m) => m.direction === 'INBOUND').body,
    envioConfirmadoPorEvidencia: envio.confirmation_source || null,
  };
}

test('swap_mesma_suite_dois_adapters_resultado_igual', async () => {
  const a = await cenario('messaging-sandbox');
  const b = await cenario('messaging-alt-sandbox');
  assert.deepEqual(a.statusDaMensagem, ['QUEUED', 'SENT', 'DELIVERED']);
  assert.equal(a.estadoDoEnvio, 'CONFIRMED');
  assert.deepEqual(a.eventosInternos, ['integration.messaging.message.status']);
  assert.deepEqual(b, a, 'o mesmo resultado interno, a mesma sequência de eventos e os mesmos estados de envio nos dois fornecedores');
});

test('swap_no_meio_preserva_conversation_id', async () => {
  const antiga = await env.conectar(tenant, 'messaging-sandbox');
  const p = await env.pessoa(tenant);
  for (let i = 0; i < 10; i += 1) await env.enviarMensagem(tenant, { kind: 'text', personId: p.id, to: p.phone, text: `antes ${i}` });
  await env.rodarEnvios(tenant);
  const nova = await env.criarCanal(tenant, { provider: 'messaging-alt-sandbox' });
  const r = await trocar(antiga.conn.id, nova.conn.id);
  assert.equal(r.from.status, 'PAUSED');
  assert.equal(r.to.status, 'ACTIVE');
  for (let i = 0; i < 10; i += 1) await env.enviarMensagem(tenant, { kind: 'text', personId: p.id, to: p.phone, text: `depois ${i}` });
  await env.rodarEnvios(tenant);
  const msgs = (await env.mensagensDa(tenant, p.id)).filter((m) => m.direction === 'OUTBOUND');
  assert.equal(msgs.length, 20, '20 mensagens na mesma conversa');
  assert.deepEqual([...new Set(msgs.map((m) => m.connection_id))].sort(), [antiga.conn.id, nova.conn.id].sort(), '2 pares externos (connection + id)');
  assert.equal(msgs.filter((m) => m.connection_id === antiga.conn.id).length, 10, 'o par antigo permanece como histórico');
  assert.ok(msgs.every((m) => m.person_id === p.id && m.external_message_id), 'ids internos intactos e todas aceitas');
  const conversas = await env.sql(tenant, "SELECT DISTINCT payload_snapshot->>'conversationId' AS c FROM integration.dispatches WHERE id IN (:ids)", { ids: msgs.map((m) => m.dispatch_id) });
  assert.deepEqual(conversas.map((c) => c.c), [p.id], 'a conversa interna é a mesma antes e depois da troca');
  const [aud] = await env.sql(tenant, "SELECT count(*)::int AS n FROM audit.audit_log WHERE action = 'integration.provider.swap' AND entity_id = :id", { id: nova.conn.id });
  assert.equal(aud.n, 1, 'a troca fica na auditoria');
});

test('swap_dispatch_em_voo_drena_na_antiga', async () => {
  const antiga = await env.conectar(tenant, 'messaging-sandbox');
  const p = await env.pessoa(tenant);
  const emVoo = [];
  for (let i = 0; i < 3; i += 1) emVoo.push(await env.enviarMensagem(tenant, { kind: 'text', personId: p.id, to: p.phone, text: `em voo ${i}` }));
  const nova = await env.criarCanal(tenant, { provider: 'messaging-alt-sandbox' });
  await trocar(antiga.conn.id, nova.conn.id);
  assert.equal((await statusDe(antiga.conn.id)).policy_json.swap.draining, true);
  const depois = await env.enviarMensagem(tenant, { kind: 'text', personId: p.id, to: p.phone, text: 'nova' });
  await env.rodarEnvios(tenant);
  for (const r of emVoo) {
    const m = await env.mensagem(tenant, r.message.id);
    assert.equal(m.connection_id, antiga.conn.id, 'o envio em voo termina na connection antiga');
    assert.equal(m.delivery_status, 'SENT');
    assert.match(m.external_message_id, /^sbx-msg-/);
  }
  const nova1 = await env.mensagem(tenant, depois.message.id);
  assert.equal(nova1.connection_id, nova.conn.id, 'o envio novo resolve a connection nova');
  assert.match(nova1.external_message_id, /^alt-msg-/);
  await env.rodarEnvios(tenant); // a rodada seguinte vê a fila da antiga vazia e encerra a drenagem
  const s = await statusDe(antiga.conn.id);
  assert.equal(s.status, 'PAUSED');
  assert.equal(s.policy_json.swap.draining, false);
  // Sem drenagem em curso, connection pausada volta a não enviar nada.
  const cru = await env.envioDe(tenant, emVoo[0].dispatchId);
  assert.ok(['SUBMITTED', 'CONFIRMED'].includes(cru.status));
});

test('swap_dominios_diferentes_recusado', async () => {
  const msg = await env.conectar(tenant, 'messaging-sandbox');
  const assinatura = await env.comTenant(tenant, (t) => registry.createConnection({ providerCode: 'signature-sandbox', environment: 'SANDBOX', label: `QA-M9 ${env.uniqueSuffix()}` }, env.ctxDe(tenant), t));
  await assert.rejects(trocar(msg.conn.id, assinatura.id), (e) => e.statusCode === 422 && e.code === 'INTEGRATION_SWAP_DOMAIN_MISMATCH' && e.message === 'A nova integração precisa ser da mesma família.');
  assert.equal((await statusDe(msg.conn.id)).status, 'ACTIVE', 'a recusa não mexe em nada');
  // Duas ativas do mesmo fornecedor e ambiente nunca: ativar a segunda sem pausar a primeira é recusado.
  const outra = await env.criarCanal(tenant, { provider: 'messaging-sandbox' });
  await assert.rejects(env.comTenant(tenant, (t) => registry.transitionConnection(outra.conn.id, 'ACTIVE', env.ctxDe(tenant), t)), (e) => e.statusCode === 409 && e.code === 'INTEGRATION_CONNECTION_DUPLICATE_ACTIVE');
  // Origem que não está ativa e destino já ativo também não trocam.
  await assert.rejects(trocar(outra.conn.id, msg.conn.id), (e) => e.statusCode === 409);
});

test('swap_capability_ausente_degrada_declarado', async () => {
  const antiga = await env.conectar(tenant, 'messaging-sandbox');
  const p = await env.pessoa(tenant);
  const comMidia = await env.enviarMensagem(tenant, { kind: 'media', personId: p.id, to: p.phone, mediaRef: 'file:planta', caption: 'Planta', mediaClassification: 'PUBLIC' });
  assert.equal(comMidia.degraded, false);
  assert.equal(comMidia.operation, 'sendMedia');
  const nova = await env.criarCanal(tenant, { provider: 'messaging-alt-sandbox' });
  await trocar(antiga.conn.id, nova.conn.id);
  const semMidia = await env.enviarMensagem(tenant, { kind: 'media', personId: p.id, to: p.phone, mediaRef: 'file:planta', caption: 'Planta', mediaClassification: 'PUBLIC' });
  assert.equal(semMidia.degraded, true, 'sem sendMedia o CRM envia texto com a referência');
  assert.equal(semMidia.operation, 'sendText');
  await env.rodarEnvios(tenant);
  assert.equal((await env.mensagem(tenant, semMidia.message.id)).delivery_status, 'SENT', 'degradar nunca falha');
  const adapter = require('../../../src/features/integrations/registry/adapterRegistry').instantiate('messaging-alt-sandbox');
  assert.equal(adapter.supports('sendMedia'), false);
  assert.equal(adapter.supports('sendText'), true);
});
