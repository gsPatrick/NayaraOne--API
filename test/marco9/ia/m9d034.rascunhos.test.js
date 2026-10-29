'use strict';

// M9-D034 — "descrições" e "recuperação" do livro: só rascunho de texto, com os fatos do cadastro (nada inventado) e fonte; nada é
// publicado nem enviado.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const { sequelize, prepararTenants, q, uid } = require('../../helpers/aiAgents');
const { espiaRegistry } = require('../_helpers/iaEspia');
const C = require('../_helpers/iaComercial');
const propertiesService = require('../../../src/features/properties/properties.service');
const offersService = require('../../../src/features/properties/propertyOffers.service');

let tenantA;
before(async () => { ({ tenantA } = await prepararTenants()); });
after(async () => { await sequelize.close(); });

const imovel = async (c, extra = {}) => {
  const t = c.tenant;
  const p = await propertiesService.createProperty({ groupId: t.groupId, companyId: t.companyId, title: `Casa do rascunho ${uid().slice(0, 6)}`, internalCode: `RSC-${uid().slice(0, 8)}`, propertyType: 'RESIDENTIAL', city: 'Curitiba', areaTotalM2: 120, ...extra }, t.userId, c.tx);
  await offersService.createOffer(p.id, { offerType: 'SALE', askingPrice: 750000 }, t.userId, c.tx);
  return p;
};
const BANNER = 'RASCUNHO — não foi publicado nem enviado; revise antes de usar.';

test('m9d034_descricao_de_imovel_e_rascunho_com_fontes_sem_inventar_atributo', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const { registry, pedidos } = espiaRegistry();
    const c = await C.cenario(tenantA, tx, { deps: { registry } });
    const p = await imovel(c);
    const antes = (await q('SELECT publication_status, description, description_public, updated_at FROM real_estate.properties WHERE id = :id', { id: p.id }, tx))[0];
    const { outcome: o } = await c.pedir('rascunhar_descricao_imovel', 'Escreva a descrição do imóvel', { body: { context: { entityType: 'property', entityId: p.id } } });
    assert.equal(o.ok, true, JSON.stringify(o.error));
    assert.equal(o.answer.split('\n')[0], BANNER);
    assert.match(o.answer, /área total: 120/);
    assert.match(o.answer, /cidade: Curitiba/);
    assert.match(o.answer, /preço: R\$ 750\.000,00/);
    for (const inventado of ['quartos', 'vagas', 'piscina', 'varanda', 'churrasqueira', 'mobiliado']) assert.ok(!o.answer.toLowerCase().includes(inventado), `não inventa ${inventado}`);
    assert.deepEqual(o.sources.map((s) => s.title), ['properties']);
    assert.equal(o.structured.rascunho, true);
    assert.equal(pedidos.length, 0, 'texto montado só do cadastro, sem modelo');
    const depois = (await q('SELECT publication_status, description, description_public, updated_at FROM real_estate.properties WHERE id = :id', { id: p.id }, tx))[0];
    assert.deepEqual(depois, antes, 'o imóvel não foi alterado nem publicado');
    // Com atributos preenchidos, entram — e só eles.
    const q2 = await imovel(c, { bedrooms: 3, parkingSpots: 2 });
    const { outcome: com } = await c.pedir('rascunhar_descricao_imovel', `Descrição do imóvel ${q2.id}`);
    assert.match(com.answer, /quartos: 3/);
    assert.match(com.answer, /vagas: 2/);
    // Imóvel de outra empresa ou inexistente: 404 sem revelar existência.
    const { outcome: nada } = await c.pedir('rascunhar_descricao_imovel', 'Descrição', { body: { context: { entityType: 'property', entityId: '5b1c2e0a-3f4d-4a6b-9c7d-1a2b3c4d5e6f' } } });
    assert.equal(nada.error.code, 'AI_CROSS_COMPANY_BLOCKED');
    // Pedir para publicar é recusa de fronteira.
    const { outcome: publicar } = await c.pedir('consulta', 'Publique a descrição do imóvel no anúncio');
    assert.match(publicar.answer, /apenas redigir o rascunho/);
  });
});

test('m9d034_recuperacao_de_cliente_e_rascunho_e_nao_e_enviada', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await C.cenario(tenantA, tx, { dias: 12 });
    await C.mensagem(c, 'INBOUND');
    const antes = await C.mensagensDe(c);
    const { outcome: o } = await c.pedir('rascunhar_recuperacao_cliente', 'Escreva uma mensagem para retomar o cliente');
    assert.equal(o.ok, true, JSON.stringify(o.error));
    assert.equal(o.answer.split('\n')[0], BANNER);
    assert.match(o.answer, /Olá, QA-M9 Lead/);
    assert.match(o.answer, /há 12 dias/);
    assert.equal(o.structured.enviada, false);
    assert.deepEqual(o.sources.map((s) => s.title), ['crm.opportunities']);
    assert.equal(await C.mensagensDe(c), antes, 'nenhuma mensagem saiu');
    const msg = await q("SELECT count(*)::int AS n FROM integration.outbox_events WHERE event_type LIKE 'crm.message%' AND payload_json::text LIKE :id", { id: `%${c.opp.id}%` }, tx);
    assert.equal(msg[0].n, 0, 'nenhum evento de envio');
    const { outcome: enviar } = await c.pedir('consulta', 'Envie a mensagem de recuperação por WhatsApp para o cliente da oportunidade');
    assert.match(enviar.answer, /apenas redigir o rascunho/);
    assert.equal(await C.mensagensDe(c), antes);
  });
});
