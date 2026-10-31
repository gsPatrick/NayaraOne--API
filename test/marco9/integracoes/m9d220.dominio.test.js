'use strict';

// Marco 9, M9-D220 — falha externa não corrompe o domínio, no banco descartável: o estado do domínio só muda por evento interno, a reação ao evento é idempotente e auditada,
// a compensação cria um NOVO envio sem tocar no original, o usuário recebe o aceite com o fornecedor fora, dado externo fora do formato não entra e um anúncio que falha não reverte o imóvel.
process.env.PORT = process.env.M9D220_DOMINIO_PORT || require('../_helpers/portaLivre').portaLivre();

const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d229Env');
const env236 = require('../_helpers/m9d236Env');
const { programavel, erroHttp } = require('../_helpers/m9d214Scripted');
const { instalarTemporario, restaurarAdaptadores } = require('../_helpers/m9d250Env');
const settingsService = require('../../../src/features/settings/settings.service');
const registry = require('../../../src/features/integrations/registry/registry.service');
const dispatchService = require('../../../src/features/integrations/dispatch/enqueue/dispatch.service');
const { compensateDispatch } = require('../../../src/features/integrations/domain');
const { runEventConsumers } = require('../../../src/engines/events/consumers');
const { OutboxEvent } = require('../../../src/models');
const { SignatureSandboxAdapter } = require('../../../src/features/integrations/providers/signature/sandbox/signature-sandbox.adapter');
const { PortalAdapter } = require('../../../src/features/integrations/providers/portal/portal.port');
const propertiesService = require('../../../src/features/properties/properties.service');

let tenant;
let desligarCofre;
before(async () => {
  tenant = (await env.carregarTenants()).tenant;
  desligarCofre = env.useTempSecretStore();
  await new Promise((resolve) => { setTimeout(resolve, 300); });
});
afterEach(() => { restaurarAdaptadores(); });
after(async () => {
  await env.comTenant(tenant, (t) => settingsService.upsertSetting('integration.sync_call_timeout_ms', 5000, tenant, tenant.userId, t));
  await env.pausar(tenant);
  desligarCofre();
  await env.sequelize.close();
  process.exit(0);
});

const sql = (consulta, replacements) => env.sql(tenant, consulta, replacements);
const config = (id, cfg) => sql('UPDATE integration.connections SET config_json = CAST(:c AS jsonb) WHERE id = :id', { id, c: JSON.stringify(cfg) });

test('dominio_nao_muda_sem_evento_interno', async () => {
  // Mensagem: o fornecedor fora (503) não muda a mensagem do CRM; ela fica QUEUED e o envio, em nova tentativa.
  const canal = await env.conectar(tenant, 'messaging-sandbox', { config: { sandbox_fault: '503' } });
  const p = await env.pessoa(tenant);
  const r = await env.enviarMensagem(tenant, { kind: 'text', personId: p.id, to: p.phone, text: 'fornecedor fora' });
  await env.rodarEnvios(tenant);
  const m = await env.mensagem(tenant, r.message.id);
  assert.equal(m.delivery_status, 'QUEUED');
  assert.equal(m.external_message_id, null);
  assert.equal((await env.envioDe(tenant, r.dispatchId)).status, 'RETRY_WAIT');
  assert.ok(canal.conn.id);
  // Contrato: timeout depois do envio (resposta incerta) não muda o contrato; ele segue SIGNING e o envelope PENDING até o fornecedor dizer outra coisa.
  await env236.conectar(tenant, 'sandbox', 'signature-sandbox', { config: { sandbox_fault: 'TIMEOUT_AFTER_SEND' } });
  const contrato = await env236.criarContrato(tenant);
  await env236.pedirAssinatura(tenant, contrato.version, [contrato.tenantPerson, contrato.landlord]);
  const envelope = await env236.envelopeDe(tenant, contrato.version.id);
  assert.equal(envelope.status, 'PENDING');
  assert.equal((await env.envioDe(tenant, envelope.dispatch_id)).status, 'UNKNOWN');
  assert.equal(await env236.statusContrato(tenant, contrato.contract.id), 'SIGNING', 'a ausência de resposta nunca muda o estado do domínio');
});

test('dominio_consumo_idempotente', async () => {
  await env.conectar(tenant, 'messaging-sandbox', { config: { sandbox_fault: 'invalid_number' } });
  const p = await env.pessoa(tenant);
  const r = await env.enviarMensagem(tenant, { kind: 'text', personId: p.id, to: p.phone, text: 'vai falhar' });
  await env.rodarEnvios(tenant);
  const [linha] = await sql("SELECT id FROM integration.outbox_events WHERE event_type = 'integration.dispatch.failed' AND payload_json->>'dispatchId' = :d", { d: r.dispatchId });
  // O mesmo evento entregue duas vezes (reentrega do despachante): a reação roda uma única vez.
  const resultados = await env.comTenant(tenant, async (t) => {
    const evento = await OutboxEvent.findByPk(linha.id, { transaction: t });
    return [await runEventConsumers(evento, t), await runEventConsumers(evento, t)];
  });
  assert.equal(resultados.length, 2);
  assert.equal((await env.mensagem(tenant, r.message.id)).delivery_status, 'FAILED');
  const [{ n }] = await sql("SELECT count(*)::int AS n FROM audit.audit_log WHERE action = 'integration.reaction.crm.messaging.dispatch_failed' AND entity_id = :id", { id: r.message.id });
  assert.equal(n, 1, 'uma reação auditada para o evento entregue duas vezes');
  const [{ s }] = await sql("SELECT count(*)::int AS s FROM integration.outbox_events WHERE event_type = 'crm.message.status_changed' AND payload_json->>'status' = 'FAILED' AND aggregate_id = :id", { id: r.message.id });
  assert.equal(s, 1, 'o domínio aplicou o evento uma vez');
  const [{ i }] = await sql("SELECT count(*)::int AS i FROM integration.integration_inbox WHERE consumer_name = 'crm.messaging.dispatch_failed' AND event_id = :e", { e: linha.id });
  assert.equal(i, 1);
});

test('dominio_compensacao_cria_novo_dispatch', async () => {
  await env236.conectar(tenant, 'sandbox', 'signature-sandbox');
  const contrato = await env236.criarContrato(tenant);
  await env236.pedirAssinatura(tenant, contrato.version, [contrato.tenantPerson, contrato.landlord]);
  const envelope = await env236.envelopeDe(tenant, contrato.version.id);
  const original = await env.envioDe(tenant, envelope.dispatch_id);
  assert.ok(['SUBMITTED', 'CONFIRMED'].includes(original.status) && original.external_resource_id);
  const comp = () => env.comTenant(tenant, (t) => compensateDispatch(env.ctxDe(tenant), original.id, { userId: tenant.userId, transaction: t }));
  const primeira = await comp();
  assert.equal(primeira.created, true);
  assert.equal(primeira.dispatch.operation, 'cancelEnvelope');
  assert.notEqual(primeira.dispatch.id, original.id);
  assert.equal((await comp()).dispatch.id, primeira.dispatch.id, 'pedir de novo devolve a mesma compensação');
  await env.rodarEnvios(tenant);
  const depois = await env.envioDe(tenant, original.id);
  assert.equal(depois.status, original.status, 'o envio original foi preservado');
  assert.equal(depois.external_resource_id, original.external_resource_id);
  assert.equal(String(depois.updated_at), String(original.updated_at));
  const feita = await env.envioDe(tenant, primeira.dispatch.id);
  assert.ok(['SUBMITTED', 'CONFIRMED'].includes(feita.status), 'a compensação foi enviada ao fornecedor');
  const ops = await sql('SELECT operation FROM integration.dispatches WHERE aggregate_id = :a ORDER BY created_at', { a: contrato.version.id });
  assert.deepEqual(ops.map((o) => o.operation), ['createEnvelope', 'cancelEnvelope']);
  await assert.rejects(env.comTenant(tenant, (t) => compensateDispatch(env.ctxDe(tenant), feita.id, { transaction: t })), (e) => e.statusCode === 422 && e.code === 'INTEGRATION_COMPENSATION_UNSUPPORTED');
});

test('dominio_usuario_recebe_aceite_com_fornecedor_fora', async () => {
  // Fornecedor lento: o pedido de assinatura responde dentro de integration.sync_call_timeout_ms, sem erro, e o envio fica incerto para a reconciliação.
  await env.comTenant(tenant, (t) => settingsService.upsertSetting('integration.sync_call_timeout_ms', 300, tenant, tenant.userId, t));
  const Lento = class extends SignatureSandboxAdapter {
    async createEnvelope(ctx, request, meta) { await new Promise((resolve) => { setTimeout(resolve, 2500); }); return super.createEnvelope(ctx, request, meta); }
  };
  instalarTemporario(Lento);
  await env236.conectar(tenant, 'sandbox', 'signature-sandbox');
  const contrato = await env236.criarContrato(tenant);
  const t0 = Date.now();
  const assinaturas = await env236.pedirAssinatura(tenant, contrato.version, [contrato.tenantPerson, contrato.landlord]);
  const ms = Date.now() - t0;
  assert.equal(assinaturas.length, 2, 'o usuário recebe o aceite');
  assert.ok(ms < 2000, `não esperou o fornecedor lento (${ms} ms)`);
  const envelope = await env236.envelopeDe(tenant, contrato.version.id);
  assert.equal((await env.envioDe(tenant, envelope.dispatch_id)).status, 'UNKNOWN');
  assert.equal(await env236.statusContrato(tenant, contrato.contract.id), 'SIGNING');
  // Mensagem: com o fornecedor fora a ação responde aceite (QUEUED), nunca erro.
  restaurarAdaptadores();
  await env.conectar(tenant, 'messaging-sandbox', { config: { sandbox_fault: '500' } });
  const p = await env.pessoa(tenant);
  const r = await env.enviarMensagem(tenant, { kind: 'text', personId: p.id, to: p.phone, text: 'aceite' });
  assert.equal(r.status, 'QUEUED');
});

test('dominio_dado_externo_rejeitado_nao_grava', async () => {
  const canal = await env.conectar(tenant, 'messaging-sandbox');
  const p = await env.pessoa(tenant);
  const r = await env.enviarMensagem(tenant, { kind: 'text', personId: p.id, to: p.phone, text: 'dado externo' });
  await env.rodarEnvios(tenant);
  const m = await env.mensagem(tenant, r.message.id);
  // Webhook fora do esquema (status com formato proibido): vai para a fila morta e nada muda na mensagem.
  const ruim = env.evento({ resourceId: m.external_message_id, status: 'ENTREGUE 123 !!' });
  assert.equal((await env.enviar(canal, ruim)).status, 200);
  await env.rodar(tenant);
  const linha = await env.linha(tenant, canal.provider, ruim.id);
  assert.equal(linha.status, 'DEAD_LETTER');
  assert.equal((await env.mensagem(tenant, m.id)).delivery_status, 'SENT');
  // Consulta síncrona com resposta ilegível: 502 INTEGRATION_EXTERNAL_DATA_REJECTED e a mensagem não muda.
  await config(canal.conn.id, { sandbox_fault: 'wrong_type' });
  await assert.rejects(env.refrescar(tenant, m.id), (e) => e.statusCode === 502 && e.code === 'INTEGRATION_EXTERNAL_DATA_REJECTED' && /nada foi alterado/.test(e.message));
  await config(canal.conn.id, { sandbox_fault: 'unknown_status' });
  await assert.rejects(env.refrescar(tenant, m.id), (e) => e.code === 'INTEGRATION_EXTERNAL_DATA_REJECTED');
  assert.equal((await env.mensagem(tenant, m.id)).delivery_status, 'SENT');
});

test('dominio_falha_um_portal_nao_reverte_imovel', async () => {
  // Três anúncios (ZAP, OLX e VivaReal) saem do mesmo ato de publicar; o fornecedor recusa o da OLX. O imóvel fica publicado, dois anúncios são aceitos e o da OLX fica pendente.
  const Portal = programavel(PortalAdapter, 'portal-sandbox', ['publishListing', 'updateListing', 'unpublishListing', 'getListingStatus']);
  Portal.S.aoChamar = async (op, request) => { if (op === 'publishListing' && String(request.listingRef).startsWith('olx')) throw erroHttp(503); };
  instalarTemporario(Portal);
  await sql("UPDATE integration.connections SET status = 'PAUSED' WHERE company_id = :c AND provider_code = 'portal-sandbox' AND status = 'ACTIVE'", { c: tenant.companyId });
  const conn = await env.comTenant(tenant, (t) => registry.createConnection({ providerCode: 'portal-sandbox', environment: 'SANDBOX', label: `QA-M9 ${env.uniqueSuffix()}` }, env.ctxDe(tenant), t));
  await env.comTenant(tenant, (t) => registry.transitionConnection(conn.id, 'ACTIVE', env.ctxDe(tenant), t));
  const imovel = await env.comTenant(tenant, (t) => propertiesService.createProperty({ groupId: tenant.groupId, companyId: tenant.companyId, title: `QA-M9 Imóvel ${env.uniqueSuffix()}`, internalCode: `QA-${env.uniqueSuffix()}`, propertyType: 'RESIDENTIAL', city: 'Cidade QA' }, tenant.userId, t));
  const ids = await env.comTenant(tenant, async (t) => {
    await sql_(t, "UPDATE real_estate.properties SET publication_status = 'PUBLISHED' WHERE id = :id", { id: imovel.id });
    const saida = [];
    for (const portal of ['zap', 'olx', 'vivareal']) {
      const r = await dispatchService.enqueue({ companyId: tenant.companyId, connectionId: conn.id, operation: 'publishListing', aggregateType: 'Property', aggregateId: imovel.id, payload: { public_code: `${portal}-${imovel.id}` }, userId: tenant.userId, transaction: t });
      saida.push({ portal, dispatchId: r.dispatchId });
    }
    return saida;
  });
  await env.rodarEnvios(tenant);
  const estados = {};
  for (const { portal, dispatchId } of ids) estados[portal] = (await env.envioDe(tenant, dispatchId)).status;
  assert.ok(['SUBMITTED', 'CONFIRMED'].includes(estados.zap) && ['SUBMITTED', 'CONFIRMED'].includes(estados.vivareal), JSON.stringify(estados));
  // Publicar anúncio é operação perigosa sem chave de idempotência: o 503 não repete às cegas (tabela única da D216) e o envio fica incerto, à espera da consulta de reconciliação.
  assert.ok(['RETRY_WAIT', 'UNKNOWN'].includes(estados.olx), `o portal que caiu fica pendente (${estados.olx})`);
  const [prop] = await sql('SELECT publication_status FROM real_estate.properties WHERE id = :id', { id: imovel.id });
  assert.equal(prop.publication_status, 'PUBLISHED', 'nenhum rollback do imóvel por causa do portal que caiu');
});

async function sql_(t, consulta, replacements) {
  return env.sequelize.query(consulta, { replacements, transaction: t });
}
