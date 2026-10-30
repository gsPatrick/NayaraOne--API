'use strict';

// M9-D427 — site e SEO: URL canônica pelo publicId imutável, metadata e JSON-LD só de campos verdadeiros, endereço restrito, ciclo da página
// (ATIVO, VENDIDO/ALUGADO, REMOVIDO) com datas, e a política de página vendida com exatamente dois valores. Postgres real (RLS FORCE),
// transação com rollback. Só em banco descartável (node scripts/withDisposableDb.js).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../../../src/models');
const { getSeedTenant, withRollbackTenantTransaction } = require('../../testHelpers');
const seo = require('../../../src/features/marketing/publications/seo');
const { upsertSetting } = require('../../../src/features/settings/settings.service');
const env = require('../_helpers/mktSeoEnv');

const { makeProperty, changeState, q, DAY } = env;
let A;
before(async () => { A = await getSeedTenant(); });
after(async () => { await sequelize.close(); });

const page = (t, key, now) => seo.service.getPublicPage({ key, now, transaction: t });
const T0 = new Date('2026-11-01T15:00:00Z'); // 12:00 em São Paulo

test('canonical_usa_public_id_imutavel', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    const prop = await makeProperty(t, A);
    const first = await page(t, prop.public_id, new Date());
    assert.equal(first.http, 200);
    assert.equal(first.canonicalPath, `/imoveis/venda/residencial/jardim-europa/residencial-3q-${prop.public_id}`);
    assert.equal(first.seo.canonical, first.canonicalPath, 'sem URL base o canonical é o caminho; nunca leva UTM');
    // o slug muda (4 quartos) e o link antigo continua resolvendo pelo publicId, apontando para o canonical novo
    await q(t, 'UPDATE real_estate.properties SET bedrooms = 4 WHERE id = :id RETURNING id', { id: prop.id });
    const renamed = await page(t, `${first.canonicalPath}?utm_source=newsletter`, new Date());
    assert.equal(renamed.http, 200);
    assert.equal(renamed.canonicalPath, `/imoveis/venda/residencial/jardim-europa/residencial-4q-${prop.public_id}`);
    assert.ok(!renamed.seo.canonical.includes('utm_'), 'UTM nunca entra no canonical');
    // o publicId é imutável no banco
    await assert.rejects(() => q(t, 'UPDATE real_estate.properties SET public_id = gen_random_uuid() WHERE id = :id RETURNING id', { id: prop.id }), /MKT_PUBLIC_ID_IMMUTABLE/);
  });
});

test('canonical_absoluto_com_a_url_base_do_parametro', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    await upsertSetting('marketing.seo.url_base', 'https://www.exemplo.test/', A, A.userId, t);
    const prop = await makeProperty(t, A);
    const out = await page(t, prop.public_id, new Date());
    assert.equal(out.seo.canonical, `https://www.exemplo.test${out.canonicalPath}`);
    assert.equal(out.seo.jsonLd.url, out.seo.canonical);
    await assert.rejects(() => upsertSetting('marketing.seo.url_base', 'http://sem-https.test', A, A.userId, t), (e) => e.code === 'MKT_PARAM_INVALID');
  });
});

test('endereco_restrito_nao_vaza_no_json_ld', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    const prop = await makeProperty(t, A); // padrão SO_BAIRRO
    const out = await page(t, prop.public_id, new Date());
    const ld = out.seo.jsonLd;
    assert.equal(ld['@type'], 'RealEstateListing');
    assert.equal(ld.about.address.addressLocality, 'São Paulo');
    assert.equal(ld.about.containedInPlace.name, 'Jardim Europa');
    assert.equal(ld.about.address.streetAddress, undefined);
    assert.equal(ld.about.geo, undefined, 'coordenada precisa nunca sai');
    const everything = JSON.stringify(out);
    for (const secret of ['Acácias', '01310', '"120"']) assert.ok(!everything.includes(secret), `não pode vazar ${secret}`);
    // OCULTO: nem o bairro sai
    const hidden = await makeProperty(t, A, { policy: 'OCULTO' });
    const outHidden = await page(t, hidden.public_id, new Date());
    assert.equal(outHidden.seo.jsonLd.about.containedInPlace, undefined);
    assert.ok(!JSON.stringify(outHidden).includes('Jardim Europa'));
    // COMPLETO: a política do imóvel permite a rua
    const full = await makeProperty(t, A, { policy: 'COMPLETO' });
    assert.match((await page(t, full.public_id, new Date())).seo.jsonLd.about.address.streetAddress, /Rua das Acácias, 120/);
  });
});

test('metadata_so_com_campos_verdadeiros', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    const prop = await makeProperty(t, A, { bedrooms: 3, price: 780000 });
    const out = await page(t, prop.public_id, new Date());
    assert.match(out.seo.title, /^Imóvel residencial com 3 quartos à venda em Jardim Europa, São Paulo$/);
    assert.match(out.seo.description, /120 m² de área total/);
    assert.match(out.seo.description, /Venda: R\$\s780\.000,00/);
    assert.match(out.seo.description, /piscina/);
    assert.equal(out.seo.jsonLd.offers.price, 780000);
    assert.equal(out.seo.jsonLd.about.numberOfBedrooms, 3);
    // campo ausente é omitido, nunca inventado: sem oferta, sem preço; sem banheiros, sem banheiros
    const bare = await makeProperty(t, A, { offer: null });
    const outBare = await page(t, bare.public_id, new Date());
    assert.equal(outBare.seo.jsonLd.offers, undefined);
    assert.ok(!/R\$/.test(outBare.seo.description) && !/banheiro/.test(outBare.seo.description));
    // metadata informada que cita dado inexistente: 422 MKT_SEO_FIELD_NOT_VERIFIED
    const model = await require('../../../src/features/marketing/content').publicReadModel.loadPublicProperty({ publicId: prop.public_id }, A, t);
    seo.assertSeoFieldsVerified({ title: 'Imóvel com 3 quartos', description: 'Venda por R$ 780.000.' }, model);
    assert.throws(() => seo.assertSeoFieldsVerified({ title: 'Cobertura com 5 quartos', description: 'Venda por R$ 1.200.000.' }, model),
      (e) => e.statusCode === 422 && e.code === 'MKT_SEO_FIELD_NOT_VERIFIED' && e.message === 'A metadata cita dado que não existe no cadastro.');
  });
});

test('imovel_vendido_segue_politica_de_redirect', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    const prop = await makeProperty(t, A);
    await changeState(t, prop.id, { availability: 'SOLD', at: T0 }); // vendido em 01/11/2026
    const day = (n) => new Date(T0.getTime() + n * DAY);
    const on1Nov = await page(t, prop.public_id, T0);
    assert.deepEqual([on1Nov.http, on1Nov.selo, on1Nov.indexable, on1Nov.seo.robots], [200, 'Vendido', false, 'noindex,nofollow']);
    const on1Dec = await page(t, prop.public_id, day(30)); // 01/12: ainda dentro dos 30 dias
    assert.deepEqual([on1Dec.http, on1Dec.selo], [200, 'Vendido']);
    const on2Dec = await page(t, prop.public_id, day(31)); // 02/12: 301 para a listagem do bairro/tipo
    assert.equal(on2Dec.http, 301);
    assert.equal(on2Dec.redirectTo, '/imoveis/venda/residencial/jardim-europa');
    // REDIRECT_IMEDIATO: 301 desde o dia da venda
    await upsertSetting('marketing.seo.politica_vendido', 'REDIRECT_IMEDIATO', A, A.userId, t);
    assert.equal((await page(t, prop.public_id, T0)).http, 301);
    // os dias vêm do parâmetro; alugado tem o selo próprio
    await upsertSetting('marketing.seo.politica_vendido', 'SELO_E_REDIRECT', A, A.userId, t);
    await upsertSetting('marketing.seo.dias_selo_vendido', 5, A, A.userId, t);
    assert.equal((await page(t, prop.public_id, day(5))).http, 200);
    assert.equal((await page(t, prop.public_id, day(6))).http, 301);
    const rented = await makeProperty(t, A, { offer: 'RENT' });
    await changeState(t, rented.id, { availability: 'RENTED', at: T0 });
    const outRented = await page(t, rented.public_id, T0);
    assert.deepEqual([outRented.http, outRented.selo], [200, 'Alugado']);
    assert.equal((await page(t, rented.public_id, day(6))).redirectTo, '/imoveis/locacao/residencial/jardim-europa');
  });
});

test('removido_devolve_410_e_politica_vendido_aceita_so_dois_valores', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    const prop = await makeProperty(t, A);
    await changeState(t, prop.id, { availability: 'WITHDRAWN', at: T0 });
    const out = await page(t, prop.public_id, T0);
    assert.equal(out.http, 410, 'removido sem venda: 410 Gone desde o primeiro dia (dias_removido = 0)');
    assert.equal(out.redirectTo, undefined, 'nunca 301 para removido');
    const inactive = await makeProperty(t, A);
    await changeState(t, inactive.id, { publication: 'INACTIVE', at: T0 });
    assert.equal((await page(t, inactive.public_id, new Date(T0.getTime() + 400 * DAY))).http, 410);
    // dias_removido > 0: antes do prazo a página fica fora do índice; depois, 410. Nunca 301.
    await upsertSetting('marketing.seo.dias_removido', 3, A, A.userId, t);
    const early = await page(t, prop.public_id, new Date(T0.getTime() + 2 * DAY));
    assert.deepEqual([early.http, early.indexable], [200, false]);
    assert.equal((await page(t, prop.public_id, new Date(T0.getTime() + 3 * DAY))).http, 410);
    // política com valor fora dos dois: 422 MKT_PARAM_INVALID
    for (const bad of ['REDIRECT_TARDIO', '', 'selo_e_redirect']) {
      await assert.rejects(() => upsertSetting('marketing.seo.politica_vendido', bad, A, A.userId, t), (e) => e.code === 'MKT_PARAM_INVALID' || e.code === 'SETTING_INVALID_VALUE', `valor ${JSON.stringify(bad)}`);
    }
    // rascunho nunca foi público: sem página (404)
    const draft = await makeProperty(t, A, { status: 'DRAFT' });
    await assert.rejects(() => page(t, draft.public_id, T0), (e) => e.statusCode === 404);
  });
});

test('parametros_do_seo_tem_o_padrao_do_livro_sao_lidos_e_validados', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    assert.deepEqual(await seo.readSeoConfig(A, t), { soldPolicy: 'SELO_E_REDIRECT', soldDays: 30, removedDays: 0, baseUrl: null, cacheSeconds: 60 });
    await upsertSetting('marketing.seo.cache_s', 0, A, A.userId, t);
    await upsertSetting('marketing.seo.dias_removido', 7, A, A.userId, t);
    assert.deepEqual([(await seo.readSeoConfig(A, t)).cacheSeconds, (await seo.readSeoConfig(A, t)).removedDays], [0, 7]);
    for (const [key, bad] of [['marketing.seo.cache_s', -1], ['marketing.seo.cache_s', 90000], ['marketing.seo.dias_selo_vendido', 4000]]) {
      await assert.rejects(() => upsertSetting(key, bad, A, A.userId, t), (e) => e.code === 'SETTING_INVALID_VALUE', `${key}=${bad}`);
    }
  });
});
