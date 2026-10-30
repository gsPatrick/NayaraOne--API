'use strict';

// M9-D409 — criação de cada um dos 10 tipos (Postgres real, RLS FORCE, transação com rollback): fonte, campos mínimos, canais,
// privacidade de SOLD_RENTED e POST_SALE e reprovação pelo validador factual. Rodar só em banco descartável:
// node scripts/withDisposableDb.js ... NODE_ENV=test node --test --test-concurrency=1 test/marco9/marketing/m9d409.tipos.test.js

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../../../src/models');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const { prepararTenants } = require('../../helpers/marketingExecucao');
const env = require('../_helpers/mktTipos');
const midiaEnv = require('../_helpers/mktMidia');
const service = require('../../../src/features/marketing/content/content.service');
const { upsertSetting } = require('../../../src/features/settings/settings.service');
const { validateAgainstFacts } = require('../../../src/features/marketing/content/pipeline.factualPort');

let tenant;
let tenantB;
before(async () => { ({ tenantA: tenant, tenantB } = await prepararTenants()); });
after(async () => { await sequelize.close(); });

const create = (t, input, actor = tenant.userId) => service.createContent({ tenant, actor, input }, t);
const reject = async (promise, status, code) => assert.rejects(promise, (e) => e.statusCode === status && e.code === code, `${status} ${code}`);
const loadItem = async (t, id) => (await env.q(t, 'SELECT * FROM marketing.content_items WHERE id = :id', { id }))[0];

async function consentedPerson(t, name, birth) {
  const personId = await env.personWithBirthday(t, tenant, { name, birth });
  await env.addConsent(t, tenant, personId, 'WHATSAPP', 'POS_VENDA', 'OPT_IN');
  return personId;
}

// 1 (com banco)
test('dez_conteudos_um_por_tipo_em_DRAFT_com_fonte_e_versao', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const prop = await env.activeProperty(t, tenant, { price: 780000 });
    await env.changePrice(t, tenant, prop.offerId, 800000, 780000);
    const sold = await env.activeProperty(t, tenant, { price: 500000 });
    await env.setAvailability(t, sold.propertyId, 'SOLD');
    const person = await consentedPerson(t, 'Maria Aparecida da Silva', '1990-03-14');
    await env.keyDelivery(t, tenant, { personId: person });
    const project = await env.publicConstruction(t, tenant);
    const campaignId = await env.campaign(t, tenant);
    const midia = await midiaEnv.authorizedFile(t, tenant); // M9-D426: o reel só nasce de mídia autorizada

    const inputs = {
      NEW_PROPERTY: { sourceEntityType: 'property', sourceEntityId: prop.propertyId, texto: 'Novo imóvel no Jardim Europa.' },
      PRICE_REDUCTION: { sourceEntityType: 'property', sourceEntityId: prop.propertyId, texto: 'Preço reduzido no Jardim Europa.' },
      SOLD_RENTED: { sourceEntityType: 'property', sourceEntityId: sold.propertyId, texto: 'Imóvel vendido no Jardim Europa.' },
      NAYARA_CONSTRUCTION: { sourceEntityType: 'construction', sourceEntityId: project, texto: 'Obra em andamento.' },
      INSTITUTIONAL: { title: 'Nossa história', texto: 'A Nayara cuida de pessoas e de imóveis.' },
      EDUCATIONAL_BLOG: { tema: 'Como financiar o primeiro imóvel', fontes: ['https://exemplo.test/fonte-1'], texto: 'Guia de financiamento.' },
      POST_SALE: { sourceEntityType: 'person', sourceEntityId: person, texto: 'Parabéns pelas chaves!' },
      BIRTHDAY_RELATIONSHIP: { sourceEntityType: 'person', sourceEntityId: person, texto: 'Feliz aniversário!' },
      SEGMENTED_CAMPAIGN: { campaignId, channels: ['WHATSAPP'], templateCode: 'CAMPANHA_X', title: 'Campanha de relacionamento', texto: 'Mensagem da campanha.' },
      VIDEO_REEL: { midiaId: midia.id, title: 'Reel do apto', texto: 'Roteiro: abertura, sala, varanda.' },
    };
    for (const [type, input] of Object.entries(inputs)) {
      const out = await create(t, { type, ...input });
      const item = await loadItem(t, out.itemId);
      assert.equal(item.status, 'DRAFT', type);
      assert.equal(item.type, type);
      assert.ok(item.current_version_id, `${type}: versão 1`);
      const wantsSource = ['property', 'construction', 'person'].includes(input.sourceEntityType);
      assert.equal(item.source_entity_type, wantsSource ? input.sourceEntityType : null, `${type}: fonte`);
      assert.equal(item.source_entity_id, wantsSource ? input.sourceEntityId : null);
      const version = (await env.q(t, 'SELECT * FROM marketing.content_versions WHERE id = :id', { id: item.current_version_id }))[0];
      assert.equal(version.version_no, 1);
      assert.equal(Boolean(version.facts_hash), wantsSource, `${type}: hash dos fatos só com fonte`);
    }
    assert.equal((await env.itemsOfType(t, tenant, 'EDUCATIONAL_BLOG')).length, 1);
    const blog = await env.bodyOf(t, (await env.itemsOfType(t, tenant, 'EDUCATIONAL_BLOG'))[0].id);
    assert.equal(blog.body_json.tema, 'Como financiar o primeiro imóvel');
    assert.deepEqual(blog.body_json.fontes, ['https://exemplo.test/fonte-1']);
  });
});

test('campo_minimo_ausente_devolve_422_MKT_CONTENT_REQUIRED_FIELD_em_cada_tipo', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const semFoto = await env.activeProperty(t, tenant, { photos: 0 });
    const comFoto = await env.activeProperty(t, tenant);
    const foto2 = await env.activeProperty(t, tenant);
    await env.q(t, 'UPDATE real_estate.properties SET bedrooms = NULL WHERE id = :id', { id: foto2.propertyId });
    const obraSemFoto = await env.publicConstruction(t, tenant, { photo: false });
    const REQUIRED = 'MKT_CONTENT_REQUIRED_FIELD';
    const message = /Faltam campos obrigatórios para este tipo de conteúdo\./;

    await assert.rejects(create(t, { type: 'NEW_PROPERTY', sourceEntityType: 'property', sourceEntityId: semFoto.propertyId }),
      (e) => e.statusCode === 422 && e.code === REQUIRED && message.test(e.message) && e.details.missing.facts.includes('fotosAutorizadas'));
    await reject(create(t, { type: 'NEW_PROPERTY', sourceEntityType: 'property', sourceEntityId: foto2.propertyId }), 422, REQUIRED); // sem quartos
    await reject(create(t, { type: 'NEW_PROPERTY', title: 'Sem fonte' }), 422, REQUIRED);
    await reject(create(t, { type: 'NAYARA_CONSTRUCTION', sourceEntityType: 'construction', sourceEntityId: obraSemFoto }), 422, REQUIRED);
    await reject(create(t, { type: 'INSTITUTIONAL', title: 'Só título' }), 422, REQUIRED);
    await reject(create(t, { type: 'INSTITUTIONAL', texto: 'Só texto' }), 422, REQUIRED);
    await reject(create(t, { type: 'EDUCATIONAL_BLOG', tema: 'Sem fontes', texto: 'x' }), 422, 'MKT_BLOG_SOURCES_REQUIRED'); // M9-D427: blog sem fonte tem o código próprio
    await reject(create(t, { type: 'EDUCATIONAL_BLOG', texto: 'x', fontes: ['https://www.ibge.gov.br/x | 2026-10-12'] }), 422, REQUIRED); // sem tema continua sendo campo obrigatório
    await reject(create(t, { type: 'VIDEO_REEL', title: 'Sem mídia', texto: 'roteiro' }), 422, REQUIRED);
    await reject(create(t, { type: 'VIDEO_REEL', title: 'Mídia solta', midiaId: 'midia-autorizada-001', texto: 'roteiro' }), 422, 'MKT_MEDIA_NOT_AUTHORIZED'); // M9-D426
    await reject(create(t, { type: 'SEGMENTED_CAMPAIGN', title: 'Sem público', channels: ['EMAIL'], templateCode: 'X' }), 422, REQUIRED);
    await reject(create(t, { type: 'BIRTHDAY_RELATIONSHIP', title: 'Sem pessoa' }), 422, REQUIRED);
    await reject(create(t, { type: 'POST_SALE', sourceEntityType: 'property', sourceEntityId: comFoto.propertyId }), 422, REQUIRED); // fonte do tipo errado
    // nada foi gravado pelas recusas
    assert.equal((await env.q(t, "SELECT count(*)::int AS n FROM marketing.content_items WHERE title IN ('Sem fonte', 'Só título', 'Sem mídia')"))[0].n, 0);
  });
});

test('minimo_de_fotos_vem_do_parametro_da_empresa', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const prop = await env.activeProperty(t, tenant, { photos: 2 });
    const input = { type: 'NEW_PROPERTY', sourceEntityType: 'property', sourceEntityId: prop.propertyId, texto: 'ok' };
    await create(t, input);
    await upsertSetting('marketing.conteudo.minimo_fotos', 3, tenant, tenant.userId, t);
    await assert.rejects(create(t, input), (e) => e.code === 'MKT_CONTENT_REQUIRED_FIELD' && e.details.minPhotos === 3);
  });
});

test('imovel_inativo_ou_vendido_nao_gera_NEW_PROPERTY', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const a = await env.activeProperty(t, tenant);
    await env.setPublication(t, a.propertyId, 'INACTIVE');
    const b = await env.activeProperty(t, tenant);
    await env.setAvailability(t, b.propertyId, 'SOLD');
    for (const id of [a.propertyId, b.propertyId]) {
      await assert.rejects(create(t, { type: 'NEW_PROPERTY', sourceEntityType: 'property', sourceEntityId: id, texto: 'x' }),
        (e) => e.statusCode === 422 && e.code === 'MKT_CONTENT_SOURCE_NOT_ELIGIBLE' && e.details.reason === 'PROPERTY_NOT_ACTIVE');
    }
  });
});

// 4 (com HTTP-equivalente: 422 e código do serviço que a rota usa)
test('aniversario_nao_vai_para_rede_social_na_criacao_e_no_agendamento', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const person = await env.personWithBirthday(t, tenant);
    const base = { type: 'BIRTHDAY_RELATIONSHIP', sourceEntityType: 'person', sourceEntityId: person, texto: 'Feliz aniversário!' };
    await assert.rejects(create(t, { ...base, channels: ['INSTAGRAM'] }),
      (e) => e.statusCode === 422 && e.code === 'MKT_CONTENT_CHANNEL_NOT_ALLOWED' && /não pode ser publicado neste canal/.test(e.message));
    assert.equal((await env.itemsOfType(t, tenant, 'BIRTHDAY_RELATIONSHIP')).length, 0, 'recusado antes de gravar');
    const ok = await create(t, { ...base, channels: ['WHATSAPP', 'EMAIL'] });
    // agendamento de um item aprovado em canal proibido também é recusado (a regra vale na publicação, não só na criação)
    await env.q(t, "UPDATE marketing.content_items SET status = 'APPROVED' WHERE id = :id", { id: ok.itemId });
    const when = new Date(Date.now() + 48 * 3600000).toISOString();
    await assert.rejects(service.schedule({ tenant, actor: tenant.userId, itemId: ok.itemId, channels: ['INSTAGRAM'], when }, t),
      (e) => e.statusCode === 422 && e.code === 'MKT_CONTENT_CHANNEL_NOT_ALLOWED');
  });
});

test('tipo_inexistente_devolve_400_e_nada_e_gravado', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    await reject(create(t, { type: 'NOPE', title: 'x', texto: 'x' }), 400, 'MKT_CONTENT_TYPE_INVALID');
    const { parseCreateBody } = require('../../../src/features/marketing/content/content.input');
    assert.throws(() => parseCreateBody({ type: 'NOPE', title: 'x' }), (e) => e.statusCode === 400 && e.code === 'MKT_CONTENT_TYPE_INVALID' && e.message === 'Tipo de conteúdo inválido.');
    assert.throws(() => parseCreateBody({ title: 'sem tipo' }), (e) => e.code === 'MKT_CONTENT_TYPE_INVALID');
    assert.throws(() => parseCreateBody({ type: 'INSTITUTIONAL', title: 'x', channels: 'EMAIL' }), (e) => e.code === 'MKT_VALIDATION');
    assert.throws(() => parseCreateBody({ type: 'EDUCATIONAL_BLOG', tema: 'x', fontes: [1] }), (e) => e.code === 'MKT_VALIDATION');
  });
});

test('reducao_de_preco_exige_queda_na_criacao_manual', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const queda = await env.activeProperty(t, tenant);
    await env.changePrice(t, tenant, queda.offerId, 800000, 780000);
    const aumento = await env.activeProperty(t, tenant);
    await env.changePrice(t, tenant, aumento.offerId, 800000, 820000);
    const semHistorico = await env.activeProperty(t, tenant);
    const ok = await create(t, { type: 'PRICE_REDUCTION', sourceEntityType: 'property', sourceEntityId: queda.propertyId, texto: 'Preço reduzido.' });
    assert.ok(ok.itemId);
    await assert.rejects(create(t, { type: 'PRICE_REDUCTION', sourceEntityType: 'property', sourceEntityId: aumento.propertyId, texto: 'x' }),
      (e) => e.statusCode === 422 && e.code === 'MKT_CONTENT_SOURCE_NOT_ELIGIBLE' && e.details.reason === 'NOT_A_REDUCTION');
    await reject(create(t, { type: 'PRICE_REDUCTION', sourceEntityType: 'property', sourceEntityId: semHistorico.propertyId, texto: 'x' }), 422, 'MKT_CONTENT_REQUIRED_FIELD');
  });
});

// 3 (com banco)
test('vendido_nao_expoe_comprador_nem_valor', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const prop = await env.activeProperty(t, tenant, { price: 780000 });
    await env.changePrice(t, tenant, prop.offerId, 800000, 780000);
    await env.q(t, "UPDATE real_estate.properties SET attributes_json = '{\"buyer\":\"Fulano de Tal\",\"cpfComprador\":\"123.456.789-09\"}'::jsonb WHERE id = :id", { id: prop.propertyId });
    await env.setAvailability(t, prop.propertyId, 'SOLD');
    const out = await create(t, { type: 'SOLD_RENTED', sourceEntityType: 'property', sourceEntityId: prop.propertyId, texto: 'Imóvel vendido no Jardim Europa.' });
    const { facts_snapshot_json: facts } = await env.bodyOf(t, out.itemId);
    assert.equal(facts.status, 'VENDIDO');
    for (const forbidden of ['precoVenda', 'precoLocacao', 'precoAnterior', 'condominio', 'iptu', 'logradouro', 'numeroEndereco']) {
      assert.ok(!(forbidden in facts), `${forbidden} nunca entra nos fatos de SOLD_RENTED`);
    }
    assert.doesNotMatch(JSON.stringify(facts), /Fulano|123\.456|buyer|comprador/i);
    // o texto que cita o valor final é reprovado
    const bad = validateAgainstFacts('Vendido por R$ 780.000,00 no Jardim Europa.', facts);
    assert.equal(bad.ok, false);
    // alugado
    const rented = await env.activeProperty(t, tenant);
    await env.setAvailability(t, rented.propertyId, 'RENTED');
    const r = await create(t, { type: 'SOLD_RENTED', sourceEntityType: 'property', sourceEntityId: rented.propertyId, texto: 'Imóvel alugado.' });
    assert.equal((await env.bodyOf(t, r.itemId)).facts_snapshot_json.status, 'ALUGADO');
    // imóvel ainda disponível não é "vendido/alugado"
    const free = await env.activeProperty(t, tenant);
    await reject(create(t, { type: 'SOLD_RENTED', sourceEntityType: 'property', sourceEntityId: free.propertyId, texto: 'x' }), 422, 'MKT_CONTENT_REQUIRED_FIELD');
  });
});

test('pos_venda_so_com_consentimento_e_sem_valores_ou_dados_do_contrato', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const semConsentimento = await env.personWithBirthday(t, tenant, { name: 'Joana Pereira Lima' });
    await env.keyDelivery(t, tenant, { personId: semConsentimento });
    await assert.rejects(create(t, { type: 'POST_SALE', sourceEntityType: 'person', sourceEntityId: semConsentimento, texto: 'x' }),
      (e) => e.statusCode === 422 && e.code === 'MKT_CONTENT_SOURCE_NOT_ELIGIBLE' && e.details.reason === 'NO_CONSENT');
    await env.addConsent(t, tenant, semConsentimento, 'EMAIL', 'POS_VENDA', 'OPT_IN');
    await env.addConsent(t, tenant, semConsentimento, 'EMAIL', 'ALL', 'OPT_OUT', new Date());
    await assert.rejects(create(t, { type: 'POST_SALE', sourceEntityType: 'person', sourceEntityId: semConsentimento, texto: 'x' }), (e) => e.details.reason === 'NO_CONSENT', 'OPT_OUT geral vence');

    const person = await consentedPerson(t, 'Joana Pereira Lima');
    await env.keyDelivery(t, tenant, { personId: person });
    const out = await create(t, { type: 'POST_SALE', sourceEntityType: 'person', sourceEntityId: person, texto: 'Parabéns pelas chaves, Joana!' });
    const { facts_snapshot_json: facts } = await env.bodyOf(t, out.itemId);
    assert.deepEqual(Object.keys(facts).sort(), ['dataMarco', 'dia', 'marco', 'mes', 'primeiroNome']);
    assert.equal(facts.primeiroNome, 'Joana', 'só o primeiro nome');
    assert.doesNotMatch(JSON.stringify(facts), /Pereira|Lima|valor|contrato|cpf/i);
    assert.equal(facts.marco, 'POST_SALE_KEYS');
    // pessoa sem entrega de chaves: não há fato de pós-venda
    const semChaves = await consentedPerson(t, 'Sem Chaves');
    await reject(create(t, { type: 'POST_SALE', sourceEntityType: 'person', sourceEntityId: semChaves, texto: 'x' }), 404, 'MKT_SOURCE_NOT_FOUND');
  });
});

test('isolamento_entre_empresas_a_fonte_de_outra_empresa_nao_e_encontrada', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const person = await consentedPerson(t, 'Pessoa Da Empresa A');
    await env.keyDelivery(t, tenant, { personId: person });
    await assert.rejects(
      service.createContent({ tenant: tenantB, actor: tenant.userId, input: { type: 'BIRTHDAY_RELATIONSHIP', sourceEntityType: 'person', sourceEntityId: person, texto: 'x' } }, t),
      (e) => e.statusCode === 404 || e.statusCode === 422 || e.code === 'MKT_SOURCE_NOT_FOUND' || e.code === 'MKT_CONTENT_REQUIRED_FIELD');
  });
});

test('fonte_em_tipo_humano_e_recusada_e_blog_usa_a_NAY_com_tema_e_fontes', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const prop = await env.activeProperty(t, tenant);
    await assert.rejects(create(t, { type: 'INSTITUTIONAL', title: 'x', texto: 'y', sourceEntityType: 'property', sourceEntityId: prop.propertyId }),
      (e) => e.statusCode === 400 && e.code === 'MKT_VALIDATION');
    const fx = require('../../helpers/m9d406Fixtures');
    const calls = fx.registerSandboxNay(() => 'Texto do blog escrito pela NAY.');
    try {
      const out = await create(t, { type: 'EDUCATIONAL_BLOG', tema: 'Como financiar', fontes: ['https://exemplo.test/a'] });
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0].facts, { tema: 'Como financiar', fontes: ['https://exemplo.test/a'] });
      assert.equal((await env.bodyOf(t, out.itemId)).body_json.texto, 'Texto do blog escrito pela NAY.');
    } finally {
      require('../../../src/features/marketing/content/pipeline.nayPort').clearNayDraftProvider();
    }
  });
});

test('reducao_entrega_o_percentual_pronto_para_a_NAY_sem_alterar_o_snapshot', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const prop = await env.activeProperty(t, tenant);
    await env.changePrice(t, tenant, prop.offerId, 800000, 780000);
    const fx = require('../../helpers/m9d406Fixtures');
    const calls = fx.registerSandboxNay(() => 'Preço reduzido.');
    try {
      const out = await create(t, { type: 'PRICE_REDUCTION', sourceEntityType: 'property', sourceEntityId: prop.propertyId });
      assert.equal(calls[0].facts.reducaoPercentual, '2,50');
      assert.ok(!('reducaoPercentual' in (await env.bodyOf(t, out.itemId)).facts_snapshot_json), 'o snapshot é o da fonte');
    } finally {
      require('../../../src/features/marketing/content/pipeline.nayPort').clearNayDraftProvider();
    }
  });
});
