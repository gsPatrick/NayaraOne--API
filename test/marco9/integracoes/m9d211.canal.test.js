'use strict';

// Marco 9, M9-D211 — canal do webhook: token gerado ao criar a connection, formato e tamanho pelo parâmetro, função pública de resolução e backfill.
process.env.PORT = process.env.M9D211_CANAL_PORT || require('../_helpers/portaLivre').portaLivre();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d211Env');
const registry = require('../../../src/features/integrations/registry/registry.service');
const settings = require('../../../src/features/settings/settings.service');
const { resolveChannel } = require('../../../src/features/integrations/webhooks/webhooks.resolve');
const { generateChannelToken } = require('../../../src/features/integrations/webhooks/webhooks.channel');

let tenant;
before(async () => { tenant = (await env.carregarTenants()).tenant; await new Promise((resolve) => { setTimeout(resolve, 300); }); });
after(async () => { await env.sequelize.close(); process.exit(0); });

const criar = (extra = {}) => env.comTenant(tenant, (t) => registry.createConnection({ providerCode: 'messaging-sandbox', environment: 'SANDBOX', label: `QA-M9 ${env.uniqueSuffix()}`, ...extra }, env.ctxDe(tenant), t));

test('canal_gerado_aleatorio_ao_criar_a_connection', async () => {
  const a = await criar();
  const b = await criar();
  assert.match(a.webhookChannel, /^[A-Za-z0-9_-]{32}$/, 'padrão do parâmetro: 32 caracteres');
  assert.notEqual(a.webhookChannel, b.webhookChannel);
  const proprio = `canal-proprio-${env.uniqueSuffix()}`.padEnd(30, 'x');
  assert.equal((await criar({ webhookChannel: proprio })).webhookChannel, proprio, 'canal informado e válido é mantido');
  await assert.rejects(criar({ webhookChannel: 'curto' }), (e) => e.statusCode === 400);
  await assert.rejects(criar({ webhookChannel: `${'a'.repeat(23)}!` }), (e) => e.statusCode === 400);
  const vazio = await env.comTenant(tenant, (t) => registry.updateConnection(a.id, { webhookChannel: '' }, env.ctxDe(tenant), t));
  assert.match(vazio.webhookChannel, /^[A-Za-z0-9_-]{32}$/, 'esvaziar o canal troca por um novo: a connection nunca fica sem canal');
  assert.notEqual(vazio.webhookChannel, a.webhookChannel);
});

test('canal_tamanho_vem_do_parametro', async () => {
  await env.comTenant(tenant, (t) => settings.upsertSetting('integration.webhook.channel_token_length', 44, tenant, tenant.userId, t));
  try {
    assert.equal((await criar()).webhookChannel.length, 44);
    const token = await env.comTenant(tenant, (t) => generateChannelToken(env.ctxDe(tenant), t));
    assert.match(token, /^[A-Za-z0-9_-]{44}$/);
    await assert.rejects(env.comTenant(tenant, (t) => settings.upsertSetting('integration.webhook.channel_token_length', 10, tenant, tenant.userId, t)), (e) => e.statusCode === 400);
  } finally {
    await env.sql(tenant, "DELETE FROM core.tenant_settings WHERE company_id = :c AND key = 'integration.webhook.channel_token_length'", { c: tenant.companyId });
  }
});

test('canal_resolve_pela_funcao_publica_e_ignora_desligada', async () => {
  const c = await criar();
  const r = await resolveChannel('messaging-sandbox', c.webhookChannel);
  assert.deepEqual([r.connectionId, r.groupId, r.companyId, r.environment], [c.id, tenant.groupId, tenant.companyId, 'SANDBOX']);
  assert.equal(await resolveChannel('MESSAGING-SANDBOX', c.webhookChannel).then((x) => x && x.connectionId), c.id, 'o fornecedor não diferencia maiúsculas');
  assert.equal(await resolveChannel('portal-sandbox', c.webhookChannel), null, 'o canal é único por fornecedor');
  assert.equal(await resolveChannel('messaging-sandbox', 'inexistente'.padEnd(30, 'z')), null);
  assert.equal(await resolveChannel('messaging-sandbox', "x'; DROP TABLE x;--"), null, 'formato inválido nem chega ao banco');
  await env.sql(tenant, "UPDATE integration.connections SET status = 'DISABLED' WHERE id = :id", { id: c.id });
  assert.equal(await resolveChannel('messaging-sandbox', c.webhookChannel), null, 'connection DISABLED não recebe webhook');
});

test('canal_funcao_nao_abre_as_connections_a_quem_nao_sabe_o_canal', async () => {
  const c = await criar();
  // sem a chave de sessão da função, a política de isolamento segue valendo para a leitura direta da tabela
  const direto = await env.sequelize.query('SELECT id FROM integration.connections WHERE id = :id', { replacements: { id: c.id }, type: 'SELECT' });
  assert.equal(direto.length, 0, 'sem empresa na sessão a tabela continua fechada');
  const chave = await env.sequelize.query("SELECT current_setting('app.webhook_channel_lookup', true) AS v", { type: 'SELECT' });
  assert.ok(!chave[0].v, 'a função desliga a chave de sessão ao terminar');
});

test('canal_toda_connection_existente_tem_canal', async () => {
  const sem = await env.sql(tenant, 'SELECT count(*)::int AS n FROM integration.connections WHERE company_id = :c AND webhook_channel IS NULL', { c: tenant.companyId });
  assert.equal(sem[0].n, 0, 'o backfill da migration deu canal a todas as connections');
});
