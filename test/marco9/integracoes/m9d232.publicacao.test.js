'use strict';

// Marco 9, M9-D232 — PortalAdapter: mapping/versão/capabilities por portal, vínculo com external_listing_id, hash no-op e payload só do read model.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const env = require('../_helpers/m9d232Env');
const portal = require('../../../src/features/integrations/portal');
const store = require('../../../src/features/integrations/providers/portal/sandbox/portal.sandbox.store');
const adapterRegistry = require('../../../src/features/integrations/registry/adapterRegistry');
const { invoke } = require('../../../src/features/integrations/registry/adapterInvoke');
const { PropertyOffer } = require('../../../src/models');
const { CANARY, CANARY_PRICE } = require('../_helpers/intReadModel');

const { sequelize, comTenant } = env;
let tenant;
let zap; let viva; let olx;
before(async () => { tenant = await env.carregar(); [zap, viva, olx] = await env.tresPortais(); });
after(async () => { await sequelize.close(); });

const publicar = (propertyId, connectionIds) => comTenant(tenant, (t) => portal.publishToPortals(env.ctxDe(tenant), { propertyId, connectionIds }, t));
const sincronizar = () => portal.syncListingStatuses({ group: env.grupo, company: env.empresa });
const porPortal = (r, con) => r.items.find((i) => i.connectionId === con.id);

test('portal_publish_update_unpublish_getstatus', async () => {
  const imovel = await env.criarImovel(tenant);
  const r = await publicar(imovel.id);
  assert.deepEqual([r.total, r.items.every((i) => i.status === 'PUBLISHING' && i.dispatchId)], [3, true], 'um envio independente por portal');
  for (const i of r.items) await env.entregar(i.dispatchId); // eslint-disable-line no-await-in-loop
  await sincronizar();
  const vs = await env.vinculos(imovel.id);
  assert.deepEqual(vs.map((v) => v.status), ['PUBLISHED', 'PUBLISHED', 'PUBLISHED']);
  const [d] = await env.envios(vs[0].id);
  assert.equal(d.status, 'CONFIRMED', 'o status do portal (consulta) confirma o envio; a resposta de publicação não');
  // atualização: preço novo no imóvel -> hash diferente -> updateListing em cada portal
  await comTenant(tenant, (t) => PropertyOffer.update({ askingPrice: '910000.00' }, { where: { propertyId: imovel.id }, transaction: t }));
  const u = await publicar(imovel.id);
  assert.ok(u.items.every((i) => i.operation === 'updateListing' && i.dispatchId), 'mudança no read model: updateListing');
  for (const i of u.items) await env.entregar(i.dispatchId); // eslint-disable-line no-await-in-loop
  const enviado = store.lastPayload(zap.id, vs.find((v) => v.connection_id === zap.id).external_listing_id);
  assert.match(JSON.stringify(enviado), /910000/);
  // despublicar e consultar pelo contrato do port
  const adapter = await comTenant(tenant, async (t) => adapterRegistry.resolve(zap, env.ctxDe(tenant), t));
  const externo = vs.find((v) => v.connection_id === zap.id).external_listing_id;
  assert.equal((await invoke(adapter, 'unpublishListing', { externalResourceId: externo })).status, 'UNPUBLISHED');
  assert.equal((await invoke(adapter, 'getListingStatus', { externalResourceId: externo })).status, 'UNPUBLISHED');
});

test('portal_mapping_versionado_e_enums', async () => {
  const imovel = await env.criarImovel(tenant);
  const r = await publicar(imovel.id, [zap.id]);
  await env.entregar(r.items[0].dispatchId);
  await sincronizar();
  const [v] = await env.vinculos(imovel.id);
  assert.equal(v.mapping_version, '1.2.0', 'a versão do mapping fica no vínculo');
  assert.equal(r.items[0].mappingVersion, '1.2.0');
  const enviado = store.lastPayload(zap.id, v.external_listing_id);
  assert.equal(enviado.finalidade, 'SALE', 'purpose=VENDA vira SALE no portal A');
  assert.equal(enviado.tipoImovel, 'RESIDENTIAL_PROPERTY', 'o tipo do imóvel segue a tabela de enums do portal');
  assert.equal(enviado.preco, '850000.00');
});

test('portal_capability_ausente_omite_campo', async () => {
  const imovel = await env.criarImovel(tenant);
  const r = await publicar(imovel.id, [zap.id, olx.id]);
  for (const i of r.items) await env.entregar(i.dispatchId); // eslint-disable-line no-await-in-loop
  await sincronizar();
  const vs = await env.vinculos(imovel.id);
  const doZap = vs.find((v) => v.connection_id === zap.id);
  const doOlx = vs.find((v) => v.connection_id === olx.id);
  assert.ok(store.lastPayload(zap.id, doZap.external_listing_id).video, 'o portal com a capability recebe o vídeo');
  const semVideo = store.lastPayload(olx.id, doOlx.external_listing_id);
  assert.equal('video' in semVideo, false, 'capacidade ausente não falha: o campo é omitido');
  assert.deepEqual(doOlx.fields_dropped, ['video_public_url']);
  assert.deepEqual(doZap.fields_dropped, []);
  assert.equal(doOlx.status, 'PUBLISHED', 'a omissão não impede o anúncio');
});

test('portal_campo_obrigatorio_ausente_rejeita_internamente', async () => {
  const imovel = await env.criarImovel(tenant, { attributesJson: { pool: true, usableAreaM2: 98.4 } }); // sem banheiros
  const antes = store.calls(viva.id).length;
  const r = await publicar(imovel.id);
  const b = porPortal(r, viva);
  assert.deepEqual([b.status, b.rejectionReason], ['REJECTED', 'MISSING_REQUIRED:bathrooms']);
  assert.equal(b.dispatchId, null, 'rejeitado internamente: nenhum envio, o portal nem é chamado');
  assert.equal(store.calls(viva.id).length, antes);
  assert.match(b.message, /Faltam dados exigidos pelo portal/);
  assert.equal(b.code, 'INTEGRATION_PORTAL_REQUIRED_FIELD_MISSING');
  for (const con of [zap, olx]) assert.equal(porPortal(r, con).status, 'PUBLISHING', 'os outros portais seguem'); // eslint-disable-line no-restricted-syntax
  const v = (await env.vinculos(imovel.id)).find((x) => x.connection_id === viva.id);
  assert.match(v.last_error, /bathrooms|banheiros/i);
  // o corretor completa o cadastro e o mesmo vínculo publica
  await comTenant(tenant, (t) => sequelize.query("UPDATE real_estate.properties SET attributes_json = '{\"bathrooms\": 2}'::jsonb WHERE id = :id", { replacements: { id: imovel.id }, transaction: t }));
  const depois = porPortal(await publicar(imovel.id, [viva.id]), viva);
  assert.equal(depois.status, 'PUBLISHING');
  assert.equal((await env.vinculos(imovel.id)).filter((x) => x.connection_id === viva.id && !x.superseded_at).length, 1, 'um único vínculo ativo por imóvel e portal');
});

test('portal_republicar_mesmo_hash_noop', async () => {
  const imovel = await env.criarImovel(tenant);
  const r = await publicar(imovel.id, [zap.id]);
  await env.entregar(r.items[0].dispatchId);
  await sincronizar();
  const chamadas = store.calls(zap.id).length;
  const [antes] = await env.vinculos(imovel.id);
  const outra = await publicar(imovel.id, [zap.id]);
  assert.deepEqual([outra.items[0].noop, outra.items[0].dispatchId], [true, null]);
  assert.equal(store.calls(zap.id).length, chamadas, '0 chamadas ao portal');
  const [depois] = await env.vinculos(imovel.id);
  assert.equal(depois.payload_hash, antes.payload_hash);
  assert.equal((await env.envios(antes.id)).length, 1, 'nenhum envio novo');
});

test('portal_external_listing_id_persistido', async () => {
  const imovel = await env.criarImovel(tenant);
  const r = await publicar(imovel.id, [zap.id, viva.id]);
  for (const i of r.items) await env.entregar(i.dispatchId); // eslint-disable-line no-await-in-loop
  await sincronizar();
  const vs = await env.vinculos(imovel.id);
  assert.equal(vs.length, 2);
  for (const v of vs) {
    const [d] = await env.envios(v.id);
    assert.ok(v.external_listing_id, 'external_listing_id gravado no vínculo');
    assert.equal(v.external_listing_id, d.external_resource_id);
    assert.ok(v.payload_hash && v.last_synced_at);
  }
  assert.notEqual(vs[0].external_listing_id, vs[1].external_listing_id);
  await assert.rejects(comTenant(tenant, (t) => sequelize.query(
    'INSERT INTO real_estate.portal_listings (group_id, company_id, property_id, connection_id, status, mapping_version) VALUES (:g, :c, :p, :con, \'PENDING_SYNC\', \'1.0.0\')',
    { replacements: { g: tenant.groupId, c: tenant.companyId, p: imovel.id, con: zap.id }, transaction: t },
  )), /unique|duplicate/i);
});

test('portal_payload_so_do_read_model', async () => {
  // arquitetura: o código do portal não lê tabela de imóveis nem importa modelos; só o read model sanitizado e o mapper da M9-D219
  const raiz = path.join(__dirname, '../../../src/features/integrations');
  const arquivos = [...fs.readdirSync(path.join(raiz, 'providers/portal/sandbox')).map((f) => path.join(raiz, 'providers/portal/sandbox', f)), path.join(raiz, 'providers/portal/portal.mapping.js')];
  arquivos.filter((f) => f.endsWith('.js')).forEach((f) => {
    const src = fs.readFileSync(f, 'utf8');
    assert.equal(/require\([^)]*models/.test(src), false, `${path.basename(f)} importa modelos`);
    assert.equal(/real_estate\.properties|\bProperty\b|PropertyAddress|PropertyOwner/.test(src), false, `${path.basename(f)} lê dado de imóvel`);
  });
  // canário: todos os campos internos com CANARY; nada chega ao que o portal guarda
  const imovel = await env.criarImovel(tenant);
  const r = await publicar(imovel.id);
  for (const i of r.items) await env.entregar(i.dispatchId); // eslint-disable-line no-await-in-loop
  await sincronizar();
  const vs = await env.vinculos(imovel.id);
  for (const v of vs) {
    const visto = JSON.stringify(store.lastPayload(v.connection_id, v.external_listing_id));
    [CANARY, CANARY_PRICE, 'Rua Interna', '80000-000', 'Zacarias'].forEach((m) => assert.ok(!visto.includes(m), `${v.provider_code}: o portal recebeu ${m}`));
    assert.ok(visto.includes('Batel'));
  }
});
