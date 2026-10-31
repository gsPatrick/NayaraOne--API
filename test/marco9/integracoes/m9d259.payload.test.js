'use strict';

// Marco 9, M9-D259 — o que chega ao site: só a allowlist do read model público (canário D231); sem connection ativa 404; imóvel não publicável 409 sem gravar nada; operação fora das capabilities
// 422; permissões e RLS; parâmetro do idioma. Banco descartável (os testes COMMITAM).
process.env.PORT = process.env.M9D259_PAYLOAD_PORT || require('../_helpers/portaLivre').portaLivre();

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d259Env');
const { CANARY, CANARY_PRICE } = require('../_helpers/intReadModel');
const { temPontoExato } = require('../_helpers/pontoExato');
const { enqueue } = require('../../../src/features/integrations/dispatch/enqueue/dispatch.service');
const settingsService = require('../../../src/features/settings/settings.service');
const { SiteAdapter } = require('../../../src/features/integrations/providers/site/site.port');

const { comTenant, store, ctxDe } = env;
let tenant;
let outro;
let canal;
const MARCADORES = [CANARY, CANARY_PRICE, 'Rua Interna', '80000-000', 'Zacarias'];

before(async () => { ({ tenant, outro } = await env.carregarTenants()); env.useTempSecretStore(); await new Promise((r) => { setTimeout(r, 300); }); });
beforeEach(async () => { store.reset(); canal = await env.conectar(tenant, { config: { sandbox_publish_delay_ms: 3600000 } }); });
after(async () => {
  try { await env.semSite(tenant); await comTenant(tenant, (t) => env.sequelize.query("DELETE FROM core.tenant_settings WHERE company_id = :c AND key = 'integration.site.default_locale'", { replacements: { c: tenant.companyId }, transaction: t })); } finally { await env.sequelize.close(); process.exit(0); }
});

test('site_payload_somente_allowlist_do_read_model', async () => {
  const imovel = await env.novoImovel(tenant);
  const r = await env.publicar(tenant, imovel.id);
  await env.rodar(tenant);
  const envio = await env.envio(tenant, r.dispatchId);
  const gravado = JSON.stringify(envio.payload_snapshot);
  MARCADORES.forEach((m) => assert.ok(!gravado.includes(m), `o payload gravado contém ${m}`));
  assert.ok(!temPontoExato(envio.payload_snapshot), 'o payload gravado contém o ponto exato do imóvel');
  assert.ok(gravado.includes('Batel'), 'o dado público está lá');
  assert.equal(envio.purpose, 'SITE_PUBLICATION');
  // Só campos da allowlist do port (mapper de saída da D219): nada fora dela chega ao adapter.
  const permitidos = new Set(SiteAdapter.operations.publishPage.outputMapper.spec.fields.map((f) => f.name));
  assert.ok(permitidos.size >= 20, 'o mapper declara a allowlist');
  for (const campo of Object.keys(envio.payload_snapshot)) assert.ok(permitidos.has(campo), `campo fora da allowlist: ${campo}`);
  for (const campo of ['pageKey', 'slug', 'locale', 'contentRef', 'contentHash']) assert.ok(campo in envio.payload_snapshot, `${campo} segue para o site`);
  // O que o sandbox do site guardou também não tem nada interno.
  const noSite = JSON.stringify(store.pagesOf(canal.conn.id));
  MARCADORES.forEach((m) => assert.ok(!noSite.includes(m), `o site recebeu ${m}`));
  assert.ok(!temPontoExato(store.pagesOf(canal.conn.id)), 'o site recebeu o ponto exato do imóvel');
  assert.equal(envio.payload_snapshot.pageKey, `property:${envio.payload_snapshot.slug}:pt-BR`);
  assert.match(envio.payload_snapshot.contentHash, /^[0-9a-f]{64}$/);
});

test('site_sem_connection_ativa_404_e_imovel_nao_publicavel_409_sem_gravar', async () => {
  const imovel = await env.novoImovel(tenant);
  await env.semSite(tenant);
  await assert.rejects(env.publicar(tenant, imovel.id), (e) => e.statusCode === 404 && e.code === 'INTEGRATION_CONNECTION_NOT_FOUND' && e.message === 'Nenhuma integração ativa para este recurso: configure em Integrações.');
  canal = await env.conectar(tenant, {});
  const vendido = await env.novoImovel(tenant, { availabilityStatus: 'SOLD' });
  await assert.rejects(env.publicar(tenant, vendido.id), (e) => e.statusCode === 409 && e.code === 'INTEGRATION_PROPERTY_NOT_PUBLISHABLE');
  const n = await env.sql(tenant, "SELECT (SELECT count(*)::int FROM integration.site_pages WHERE property_id = :p) AS paginas, (SELECT count(*)::int FROM integration.dispatches WHERE aggregate_id = :p) AS envios", { p: vendido.id });
  assert.deepEqual(n[0], { paginas: 0, envios: 0 }, 'nada foi gravado');
  // Retirar uma página que não existe (ou de outra empresa): 404 em português.
  await assert.rejects(env.despublicar(tenant, '00000000-0000-4000-8000-000000000000'), (e) => e.statusCode === 404 && e.code === 'INTEGRATION_SITE_PAGE_NOT_FOUND');
});

test('site_operacao_fora_das_capabilities_422', async () => {
  const antes = await env.sql(tenant, "SELECT count(*)::int AS n FROM integration.dispatches WHERE connection_id = :c", { c: canal.conn.id });
  await assert.rejects(
    comTenant(tenant, (t) => enqueue({ companyId: tenant.companyId, connectionId: canal.conn.id, operation: 'publishListing', idempotencyKey: `qa-m9-d259-${env.uniqueSuffix()}`, payload: { slug: 'x' }, transaction: t })),
    (e) => e.statusCode === 422 && e.code === 'INTEGRATION_CAPABILITY_UNSUPPORTED',
  );
  assert.equal((await env.sql(tenant, "SELECT count(*)::int AS n FROM integration.dispatches WHERE connection_id = :c", { c: canal.conn.id }))[0].n, antes[0].n);
});

test('site_pagina_isolada_por_empresa_e_idioma_vem_da_configuracao', async () => {
  assert.ok(outro, 'o teste precisa do seed de dois tenants');
  const imovel = await env.novoImovel(tenant);
  const r = await env.publicar(tenant, imovel.id);
  const vista = await env.sql(outro, 'SELECT id FROM integration.site_pages WHERE id = :id', { id: r.pageId });
  assert.equal(vista.length, 0, 'a empresa B não enxerga a página da A (RLS)');
  await assert.rejects(env.despublicar(outro, r.pageId), (e) => e.code === 'INTEGRATION_SITE_PAGE_NOT_FOUND');
  // Idioma padrão da empresa: o pageKey carrega o idioma, e outro idioma é outra página.
  assert.match(r.pageKey, /:pt-BR$/);
  await comTenant(tenant, (t) => settingsService.upsertSetting('integration.site.default_locale', 'en', tenant, tenant.userId, t));
  const en = await env.publicar(tenant, imovel.id);
  assert.match(en.pageKey, /:en$/);
  assert.notEqual(en.pageId, r.pageId);
  await assert.rejects(comTenant(tenant, (t) => settingsService.upsertSetting('integration.site.default_locale', 'português do Brasil', tenant, tenant.userId, t)), (e) => e.code === 'SETTING_INVALID_VALUE');
  assert.deepEqual((await comTenant(tenant, (t) => env.site.readSiteParams(ctxDe(tenant), t))), { defaultLocale: 'en' });
});
