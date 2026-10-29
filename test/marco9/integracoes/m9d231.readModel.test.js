'use strict';

// Marco 9, M9-D231 — PublicPropertyReadModel: só campos públicos, endereço restrito, coordenada aproximada, texto redigido, fotos.
// Banco descartável: node scripts/withDisposableDb.js --port <porta> -- ... node --test --test-concurrency=1 <arquivo>
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize, comTenant, carregarTenants, ctxDe, config } = require('../../integrations/dispatch/dispatchHelpers');
const { Property } = require('../../../src/models');
const rm = require('../../../src/features/properties/publicReadModel');
const { APPROX_RADIUS_KEY } = require('../../../src/features/properties/publicReadModel/publicReadModel.settings');
const { criarImovel, CANARY, CANARY_PRICE, EXATO } = require('../_helpers/intReadModel');

let tenant;
before(async () => { ({ tenant } = await carregarTenants()); });
after(async () => { await sequelize.close(); });

const sincronizar = (id) => comTenant(tenant, (t) => rm.syncPublicPropertyReadModel(id, ctxDe(tenant), t));
const linha = (id) => comTenant(tenant, async (t) => (await sequelize.query('SELECT * FROM real_estate.public_property_read_model WHERE property_id = :id', { replacements: { id }, transaction: t }))[0][0]);
const alterar = (id, patch) => comTenant(tenant, (t) => Property.update(patch, { where: { id }, transaction: t, individualHooks: false }));

const metros = (a, b) => {
  const R = 6371000;
  const rad = (x) => (x * Math.PI) / 180;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

test('read_model_so_campos_publicos', async () => {
  const im = await criarImovel(tenant);
  const r = await sincronizar(im.id);
  assert.equal(r.status, 'UPSERTED');
  // Ausência, não filtro: a tabela só tem as colunas públicas e as de controle.
  const colunas = (await sequelize.query("SELECT column_name FROM information_schema.columns WHERE table_schema = 'real_estate' AND table_name = 'public_property_read_model'"))[0].map((c) => c.column_name);
  assert.deepEqual(colunas.filter((c) => !rm.PUBLIC_FIELDS.includes(c) && !rm.CONTROL_COLUMNS.includes(c)), [], 'nenhuma coluna fora da lista do livro');
  assert.ok(rm.PUBLIC_FIELDS.every((c) => colunas.includes(c)), 'todos os campos públicos existem');
  const publico = await comTenant(tenant, (t) => rm.loadPublicPropertyReadModel(im.id, ctxDe(tenant), t));
  assert.deepEqual(Object.keys(publico).sort(), [...rm.PUBLIC_FIELDS].sort(), 'o que sai é só a lista pública');
  assert.ok(!JSON.stringify(publico).includes(CANARY) && !JSON.stringify(publico).includes(CANARY_PRICE), 'nenhum valor interno');
  assert.equal(publico.price_public, '850000.00');
  assert.equal(publico.purpose, 'VENDA');
  assert.equal(publico.condo_fee_public, '1200.00');
  assert.equal(publico.iptu_public, '310.50');
  assert.equal(publico.bedrooms, 3);
  assert.equal(publico.bathrooms, 2);
  assert.equal(publico.area_built, '98.40');
  assert.deepEqual(publico.features_public.sort(), ['elevador', 'piscina']);
  assert.equal(publico.video_public_url, 'https://videos.exemplo.com/v/abc');
  assert.match(publico.public_code, /^IMV-[0-9A-F]{10}$/);
  assert.equal(publico.read_model_version, 1);
  // Sem mudança, a versão não sobe; com mudança de preço público, sobe.
  assert.equal((await sincronizar(im.id)).status, 'UNCHANGED');
  await comTenant(tenant, (t) => sequelize.query("UPDATE real_estate.property_offers SET asking_price = 900000 WHERE id = :id", { replacements: { id: im.offerId }, transaction: t }));
  const depois = await sincronizar(im.id);
  assert.equal(depois.status, 'UPSERTED');
  assert.equal(depois.version, 2);
});

test('read_model_endereco_restrito_sem_rua', async () => {
  const im = await criarImovel(tenant, { addressVisibility: 'RESTRICTED' });
  await sincronizar(im.id);
  const l = await linha(im.id);
  assert.equal(l.neighborhood, 'Batel');
  assert.equal(l.city, 'Curitiba');
  assert.equal(l.lat_lng_public, null, 'sem coordenada');
  const dados = JSON.stringify(Object.fromEntries(rm.PUBLIC_FIELDS.map((c) => [c, l[c]])));
  assert.ok(!dados.includes('Rua Interna') && !dados.includes('80000-000') && !dados.includes(CANARY), 'sem rua, complemento nem CEP');
  assert.deepEqual([l.neighborhood, l.city, l.state], ['Batel', 'Curitiba', 'PR']);
  assert.ok(!Object.keys(l).some((k) => /street|rua|logradouro|zip/i.test(k)), 'a coluna da rua não existe');
});

test('read_model_coordenada_aproximada_estavel', async () => {
  const im = await criarImovel(tenant, { addressVisibility: 'APPROXIMATE' });
  await sincronizar(im.id);
  const a = (await linha(im.id)).lat_lng_public;
  assert.ok(a && typeof a.lat === 'number');
  const d = metros(EXATO, a);
  assert.ok(d > 0 && d <= 300, `dentro de 300 m e nunca o ponto exato: ${d.toFixed(1)} m`);
  // Estável entre publicações: mudar outro campo e recalcular mantém a mesma coordenada.
  await alterar(im.id, { bedrooms: 4 });
  await sincronizar(im.id);
  assert.deepEqual((await linha(im.id)).lat_lng_public, a);
  // Visibilidade pública mostra o ponto exato (arredondado); o raio é parâmetro e só diminui.
  await alterar(im.id, { addressVisibility: 'PUBLIC' });
  await sincronizar(im.id);
  assert.ok(metros(EXATO, (await linha(im.id)).lat_lng_public) < 2);
  await alterar(im.id, { addressVisibility: 'APPROXIMATE' });
  await config(tenant, APPROX_RADIUS_KEY, 100);
  try {
    await sincronizar(im.id);
    const menor = (await linha(im.id)).lat_lng_public;
    assert.ok(metros(EXATO, menor) <= 100, 'raio configurado menor');
    await config(tenant, APPROX_RADIUS_KEY, 300);
  } finally {
    await config(tenant, APPROX_RADIUS_KEY, 300);
  }
  const outro = await criarImovel(tenant, { addressVisibility: 'APPROXIMATE' });
  await sincronizar(outro.id);
  assert.notDeepEqual((await linha(outro.id)).lat_lng_public, a, 'imóveis diferentes deslocam diferente');
});

test('read_model_texto_livre_redigido', async () => {
  const im = await criarImovel(tenant, {
    descriptionPublic: 'Ligue 11 99999-0000 ou escreva dono@exemplo.com. CPF 123.456.789-09. Falar com Zacarias Nogueira.',
  });
  await comTenant(tenant, (t) => sequelize.query("UPDATE real_estate.properties SET description_public = description_public || ' ' || :nome WHERE id = :id", { replacements: { nome: im.ownerName, id: im.id }, transaction: t }));
  await sincronizar(im.id);
  const texto = (await linha(im.id)).description_public;
  assert.ok(!/99999|dono@exemplo|123\.456|Zacarias/.test(texto), `PII removida: ${texto}`);
  assert.match(texto, /^Ligue/);
});

test('read_model_fotos_somente_public_clean', async () => {
  const im = await criarImovel(tenant);
  await sincronizar(im.id);
  const l = await linha(im.id);
  assert.deepEqual(l.photos_public, [im.fotoOk], 'só a PUBLIC e CLEAN; a infectada e a interna ficam de fora');
});
