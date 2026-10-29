'use strict';

// Marco 9, M9-D236 — o pedido de envelope passa pelo Dispatch Service (linha real em integration.dispatches), os segredos de webhook saem das configurações e vão ao
// cofre, e os adapters reais de assinatura cumprem o contrato IntegrationAdapter. Banco descartável.
process.env.PORT = process.env.M9D236_ARQ_PORT || '21238';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const env = require('../_helpers/m9d236Env');
const settingsService = require('../../../src/features/settings/settings.service');
const adapterRegistry = require('../../../src/features/integrations/registry/adapterRegistry');
const { IntegrationAdapter } = require('../../../src/features/integrations');
const { readConnectionSecret } = require('../../../src/features/integrations/secrets');
const { IntegrationConnection } = require('../../../src/models');
const { SignatureAdapter } = require('../../../src/features/integrations/providers/signature/signature.port');

let tenant;
let desligarCofre;
before(async () => {
  tenant = (await env.carregarTenants()).tenant;
  desligarCofre = env.useTempSecretStore();
  await new Promise((resolve) => { setTimeout(resolve, 300); });
});
after(async () => { desligarCofre(); await env.sequelize.close(); process.exit(0); });

test('assinatura_pedido_passa_pelo_dispatch_service_com_dado_minimizado', async () => {
  const canal = await env.conectar(tenant, 'sandbox', 'signature-sandbox');
  const contrato = await env.criarContrato(tenant);
  await env.pedirAssinatura(tenant, contrato.version, [contrato.tenantPerson, contrato.landlord]);
  const envelope = await env.envelopeDe(tenant, contrato.version.id);
  const [envio] = await env.sql(tenant, 'SELECT * FROM integration.dispatches WHERE id = :id', { id: envelope.dispatch_id });
  assert.equal(envio.operation, 'createEnvelope');
  assert.equal(envio.connection_id, canal.conn.id);
  assert.equal(envio.purpose, 'DOCUMENT_SIGNATURE', 'a finalidade do mapper fica gravada');
  assert.equal(envio.aggregate_type, 'ContractVersion');
  assert.equal(envio.aggregate_id, contrato.version.id);
  assert.match(envio.payload_hash, /^[0-9a-f]{64}$/, 'o hash é do conteúdo minimizado');
  assert.equal(envio.payload_snapshot.documentSha256, contrato.version.contentHash);
  assert.equal(envio.payload_snapshot.documentRef, contrato.version.id);
  assert.equal(envio.payload_snapshot.signers.length, 2);
  assert.deepEqual(Object.keys(envio.payload_snapshot.signers[0]).sort(), ['email', 'name', 'personId', 'role'], 'só os campos do mapper de saída');
  assert.equal(['SUBMITTED', 'CONFIRMED'].includes(envio.status), true, 'o worker de envios executou o pedido (circuito, cota e tentativas do framework)');
  assert.equal(envio.external_resource_id, envelope.external_envelope_id);
});

test('m9_d236_segredo_lido_pelo_secretstore', async () => {
  const segredo = `wh-clicksign-${env.uniqueSuffix()}`;
  const canal = await env.criarCanal(tenant, { provider: 'signature-clicksign', comSegredo: false });
  await env.sql(tenant, "UPDATE integration.connections SET status = 'PAUSED' WHERE company_id = :c AND provider_code = 'signature-clicksign' AND status = 'ACTIVE' AND id <> :id", { c: tenant.companyId, id: canal.conn.id });
  const { transitionConnection } = require('../../../src/features/integrations/registry/connections.transition');
  await env.comTenant(tenant, (t) => transitionConnection(canal.conn.id, 'ACTIVE', env.ctxDe(tenant), t));
  await env.comTenant(tenant, (t) => settingsService.upsertSetting('legal.clicksign_webhook_secret', segredo, tenant, tenant.userId, t));
  const guardado = async () => (await env.sql(tenant, "SELECT count(*)::int AS n FROM core.tenant_settings WHERE company_id = :c AND key = 'legal.clicksign_webhook_secret'", { c: tenant.companyId }))[0].n;
  assert.equal(await guardado(), 1);
  const post = (corpo, chave) => {
    const bruto = Buffer.from(JSON.stringify(corpo));
    return env.postar('/v1/legal/webhooks/clicksign', bruto, { 'content-hmac': `sha256=${crypto.createHmac('sha256', chave).update(bruto).digest('hex')}` });
  };
  const contrato = await env.criarContrato(tenant);
  await env.conectar(tenant, 'sandbox', 'signature-sandbox');
  await env.pedirAssinatura(tenant, contrato.version, [contrato.tenantPerson]);
  const [assinatura] = await env.assinaturas(tenant, contrato.version.id);
  const evento = { event: { name: 'upload', data: { signer: { key: assinatura.external_signature_id } } } }; // evento sem efeito, mas roteado: o HMAC é conferido
  assert.equal((await post(evento, segredo)).status, 200, 'o primeiro webhook valida com o valor antigo e migra');
  assert.equal(await guardado(), 0, 'depois da migração o valor deixa de existir em tenant_settings');
  const c = await env.comTenant(tenant, (t) => IntegrationConnection.findOne({ where: { id: canal.conn.id }, transaction: t }));
  const lido = await env.comTenant(tenant, (t) => readConnectionSecret(c, tenant, { purpose: 'webhook', kind: 'webhook', transaction: t }));
  assert.equal(lido.value.reveal(), segredo, 'o webhook agora é lido pelo SecretStore (readConnectionSecret)');
  assert.equal((await post(evento, segredo)).status, 200, 'o segundo valida só pelo cofre (a migração é idempotente)');
  assert.equal(await guardado(), 0);
  assert.equal((await post(evento, 'outro-segredo')).status, 401, 'assinatura com outro segredo continua recusada');
});

test('assinatura_adapters_reais_cumprem_o_contrato_e_zapsign_esta_registrado', async () => {
  for (const codigo of ['signature-clicksign', 'signature-zapsign', 'signature-sandbox', 'signature-alt-sandbox']) {
    assert.equal(adapterRegistry.has(codigo), true, `${codigo} registrado no AdapterRegistry`);
    const adapter = adapterRegistry.instantiate(codigo);
    assert.equal(adapter instanceof IntegrationAdapter && adapter instanceof SignatureAdapter, true, `${codigo} estende o port SignatureAdapter`);
    assert.equal(adapter.capabilities().includes('downloadSigned'), true);
    assert.ok(adapter.webhookVerifier(), `${codigo} declara o verificador do webhook`);
    assert.ok(adapter.webhookSchemas(), `${codigo} publica o esquema do evento`);
  }
  const [zap] = await env.sql(tenant, "SELECT domain, capabilities FROM integration.providers WHERE code = 'signature-zapsign'");
  assert.equal(zap.domain, 'SIGNATURE', 'ZapSign no catálogo');
  assert.deepEqual([...zap.capabilities].sort(), ['cancelEnvelope', 'createEnvelope', 'downloadSigned', 'getEnvelope', 'verifyWebhook']);
  const clicksign = adapterRegistry.instantiate('signature-clicksign');
  assert.deepEqual(clicksign.toInternalEvent({ event: { name: 'sign', occurred_at: '2026-10-29T12:00:00Z', data: { signer: { key: 'k1', email: 'a@b.c' } } } }).data, { kind: 'SIGNER_SIGNED', externalEnvelopeId: null, externalSignerId: 'k1' });
});
