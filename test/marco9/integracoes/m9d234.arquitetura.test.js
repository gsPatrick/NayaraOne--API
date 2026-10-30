'use strict';

// Marco 9, M9-D234 — o e-mail cumpre o contrato do port EmailAdapter, o pedido de envio passa pelo Dispatch Service com o conteúdo minimizado e os cinco parâmetros da
// empresa existem no dicionário de configurações. Banco descartável.
process.env.PORT = process.env.M9D234_ARQ_PORT || '21237';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d234Env');
const adapterRegistry = require('../../../src/features/integrations/registry/adapterRegistry');
const { IntegrationAdapter } = require('../../../src/features/integrations');
const { EmailAdapter } = require('../../../src/features/integrations/providers/email/email.port');
const { SETTINGS_SCHEMA } = require('../../../src/features/settings/settings.service');

let tenant;
let desligarCofre;
before(async () => {
  tenant = (await env.carregarTenants()).tenant;
  desligarCofre = env.useTempSecretStore();
  await new Promise((resolve) => { setTimeout(resolve, 300); });
});
after(async () => { desligarCofre(); await env.sequelize.close(); process.exit(0); });

test('email_adapter_cumpre_o_contrato_do_port', async () => {
  assert.equal(adapterRegistry.has('email-sandbox'), true);
  const adapter = adapterRegistry.instantiate('email-sandbox');
  assert.equal(adapter instanceof IntegrationAdapter && adapter instanceof EmailAdapter, true);
  assert.deepEqual([...adapter.capabilities()].sort(), ['getDeliveryStatus', 'receiveInbound', 'sendEmail']);
  assert.ok(adapter.webhookVerifier() && adapter.webhookSchemas());
  assert.equal(adapter.supportsIdempotency('sendEmail'), true);
  assert.equal(adapter.mapStatus('bounced_hard'), 'BOUNCED_HARD');
  assert.equal(adapter.mapStatus('inventado'), null);
  assert.deepEqual(adapter.toInternalEvent({ type: 'email.bounced', message: { id: 'm1' }, bounce: { type: 'hard', reason: 'x' } }).data, { kind: 'BOUNCED_HARD', externalMessageId: 'm1' });
  assert.equal(adapter.toInternalEvent({ type: 'email.bounced', message: { id: 'm1' } }).data.kind, 'BOUNCED_SOFT', 'bounce sem classificação nunca é presumido como definitivo');
  assert.deepEqual(Object.keys(EmailAdapter.operations.sendEmail.inputSchema.properties), []);
  assert.equal(EmailAdapter.operations.sendEmail.opClass, 'SAFE');
});

test('email_status_do_adapter_cobre_os_sete_estados_do_livro', async () => {
  const adapter = adapterRegistry.instantiate('email-sandbox');
  for (const s of ['QUEUED', 'SENT', 'DELIVERED', 'BOUNCED_SOFT', 'BOUNCED_HARD', 'COMPLAINED', 'FAILED']) assert.equal(adapter.mapStatus(s), s);
  const ordem = adapter.statusRank();
  assert.ok(ordem.SENT < ordem.DELIVERED && ordem.BOUNCED_SOFT < ordem.DELIVERED && ordem.DELIVERED < ordem.COMPLAINED);
});

test('email_parametros_declarados_no_dicionario_e_lidos', async () => {
  const chaves = ['integration.email.max_attachment_bytes', 'integration.email.attachment_allowed_types', 'integration.email.max_attachment_classification', 'integration.email.max_recipients', 'integration.email.max_attachments'];
  for (const k of chaves) assert.ok(SETTINGS_SCHEMA[k], `${k} declarado em SETTINGS_SCHEMA`);
  await env.config(tenant, 'integration.email.max_attachments', 1);
  const a = await env.criarArquivo(tenant);
  const b = await env.criarArquivo(tenant);
  await env.conectar(tenant);
  await assert.rejects(env.enviarEmail(tenant, { attachmentFileIds: [a.id, b.id] }), (e) => e.code === 'INTEGRATION_EMAIL_TOO_MANY_ATTACHMENTS');
  await env.config(tenant, 'integration.email.max_attachments', 10);
  assert.equal((await env.enviarEmail(tenant, { attachmentFileIds: [a.id, b.id] })).message.attachments.length, 2);
  await assert.rejects(env.config(tenant, 'integration.email.attachment_allowed_types', 'pdf; exe'), (e) => e.code === 'SETTING_INVALID_VALUE' || e.statusCode === 400);
  await assert.rejects(env.config(tenant, 'integration.email.max_attachment_classification', 'RESTRICTED'), (e) => e.statusCode === 400, 'o teto nunca sobe para RESTRICTED');
});

test('email_corpo_nao_vai_para_o_log_do_envio_nem_para_a_tabela', async () => {
  await env.conectar(tenant);
  const segredo = `corpo-confidencial-${env.uniqueSuffix()}`;
  const r = await env.enviarEmail(tenant, { bodyText: `Texto ${segredo}`, subject: 'Assunto' });
  const texto = JSON.stringify(r.message.toJSON());
  assert.equal(texto.includes(segredo), false, 'a mensagem de domínio não guarda o corpo');
  const [envio] = await env.sql(tenant, 'SELECT purpose, payload_hash FROM integration.dispatches WHERE id = :id', { id: r.dispatchId });
  assert.equal(envio.purpose, 'CUSTOMER_MESSAGE');
});
