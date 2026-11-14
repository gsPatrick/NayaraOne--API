'use strict';

/**
 * Marco 3 — ofertas (verificação independente de 11/11/2026: M3-07, CAD-06 e CAD-07). HTTP real; só em banco descartável.
 *  - a oferta guarda as "condições" do livro §6;
 *  - a substituição é controlada: a anterior vira SUPERSEDED com o vínculo da substituta, auditada com antes e depois, e não
 *    volta a ACTIVE nem é alterada;
 *  - o preço mínimo confidencial só aparece (e só é gravado) para quem tem properties:internal — nunca com properties:read;
 *  - alteração de preço gera histórico e o evento property.price.changed (§7).
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.PORT = process.env.M3IM_OFERTA_HTTP_PORT || '36103';

require('../app');
const { getSeedTenant, withTenantTransaction, uniqueSuffix, sequelize } = require('./testHelpers');
const { signAccessToken } = require('../src/utils/jwt');
const { AuditLog, OutboxEvent, PropertyPriceHistory } = require('../src/models');

let tenant;
let baseUrl;
let tokenInterno;
let tokenComum;
let tokenLeitura;

before(async () => {
  tenant = await getSeedTenant();
  const claims = { sub: tenant.userId, group_id: tenant.groupId, company_id: tenant.companyId, roles: ['admin'] };
  tokenInterno = signAccessToken({ ...claims, permissions: ['properties:create', 'properties:read', 'properties:update', 'properties:internal'] });
  tokenComum = signAccessToken({ ...claims, permissions: ['properties:create', 'properties:read', 'properties:update'] });
  tokenLeitura = signAccessToken({ ...claims, permissions: ['properties:read'] });
  baseUrl = `http://127.0.0.1:${process.env.PORT}/api/v1`;
  await new Promise((resolve) => setTimeout(resolve, 300));
});

after(async () => {
  await sequelize.close();
  process.exit(0);
});

async function http(method, p, body, token = tokenInterno) {
  const res = await fetch(`${baseUrl}${p}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function imovel() {
  const s = uniqueSuffix();
  const r = await http('POST', '/properties', { title: `Ofertas ${s}`, internalCode: `OF-${s}`, propertyType: 'RESIDENTIAL' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.data;
}

test('§6 condições da oferta: gravadas na criação e na alteração, devolvidas na leitura', async () => {
  const casa = await imovel();
  const cond = 'Entrada de 20%, saldo em 12 parcelas; IPTU de 2026 por conta do vendedor.';
  const o = await http('POST', `/properties/${casa.id}/offers`, { offerType: 'SALE', askingPrice: 900000, conditions: cond });
  assert.equal(o.status, 201, JSON.stringify(o.body));
  assert.equal(o.body.data.conditions, cond);
  const p = await http('PATCH', `/properties/${casa.id}/offers/${o.body.data.id}`, { conditions: 'À vista com 5% de desconto.' });
  assert.equal(p.body.data.conditions, 'À vista com 5% de desconto.');
  const lista = await http('GET', `/properties/${casa.id}/offers`);
  assert.equal(lista.body.data[0].conditions, 'À vista com 5% de desconto.');
  assert.equal((await http('POST', `/properties/${casa.id}/offers`, { offerType: 'RENT', askingPrice: 3000, conditions: 'x'.repeat(4001) })).status, 400);
});

test('M3-07 substituição controlada: vínculo com a substituta, auditada com antes e depois, e a substituída não volta nem muda', async () => {
  const casa = await imovel();
  const a = (await http('POST', `/properties/${casa.id}/offers`, { offerType: 'SALE', askingPrice: 500000 })).body.data;
  const aluguel = (await http('POST', `/properties/${casa.id}/offers`, { offerType: 'RENT', askingPrice: 2500 })).body.data;
  const b = await http('POST', `/properties/${casa.id}/offers`, { offerType: 'SALE', askingPrice: 480000 });
  assert.equal(b.status, 201);

  const ofertas = (await http('GET', `/properties/${casa.id}/offers`)).body.data;
  const antiga = ofertas.find((o) => o.id === a.id);
  assert.equal(antiga.status, 'SUPERSEDED');
  assert.equal(antiga.supersededByOfferId, b.body.data.id);
  assert.ok(antiga.supersededAt);
  assert.equal(ofertas.find((o) => o.id === aluguel.id).status, 'ACTIVE', 'a locação não é substituída pela venda');

  const aud = await withTenantTransaction(tenant, (t) => AuditLog.findOne({ where: { entityId: a.id, action: 'property_offer.supersede' }, transaction: t }));
  assert.ok(aud, 'substituição auditada');
  assert.equal(aud.beforeJson.status, 'ACTIVE');
  assert.equal(aud.afterJson.status, 'SUPERSEDED');
  assert.equal(aud.afterJson.supersededByOfferId, b.body.data.id);

  const reativar = await http('PATCH', `/properties/${casa.id}/offers/${a.id}`, { status: 'ACTIVE' });
  assert.equal(reativar.status, 409);
  assert.equal(reativar.body.error.code, 'PROPERTY_OFFER_SUPERSEDED_FINAL');
  assert.equal((await http('PATCH', `/properties/${casa.id}/offers/${a.id}`, { askingPrice: 1 })).status, 409);
  const manual = await http('PATCH', `/properties/${casa.id}/offers/${aluguel.id}`, { status: 'SUPERSEDED' });
  assert.equal(manual.status, 400);
  assert.equal(manual.body.error.code, 'PROPERTY_OFFER_STATUS_SUPERSEDED_MANUAL');

  // Reativar uma oferta PAUSADA também é substituição controlada: a ACTIVE do tipo vira SUPERSEDED, com vínculo.
  const c = (await http('POST', `/properties/${casa.id}/offers`, { offerType: 'RENT', askingPrice: 2700, status: 'PAUSED' })).body.data;
  const ativa = await http('PATCH', `/properties/${casa.id}/offers/${c.id}`, { status: 'ACTIVE' });
  assert.equal(ativa.status, 200, JSON.stringify(ativa.body));
  const depois = (await http('GET', `/properties/${casa.id}/offers`)).body.data;
  assert.equal(depois.find((o) => o.id === aluguel.id).supersededByOfferId, c.id);
});

test('M3-07 preço mínimo confidencial: some para properties:read em todas as leituras; só properties:internal vê e grava', async () => {
  const casa = await imovel();
  const comum = await http('POST', `/properties/${casa.id}/offers`, { offerType: 'SALE', askingPrice: 700000, confidentialMinPrice: 600000 }, tokenComum);
  assert.equal(comum.status, 403);
  assert.equal(comum.body.error.code, 'PROPERTY_CONFIDENTIAL_PRICE_FORBIDDEN');

  const o = await http('POST', `/properties/${casa.id}/offers`, { offerType: 'SALE', askingPrice: 700000, confidentialMinPrice: 610000 });
  assert.equal(o.status, 201);
  assert.equal(Number(o.body.data.confidentialMinPrice), 610000, 'quem tem properties:internal vê');

  for (const [rota, pegar] of [
    [`/properties/${casa.id}/offers`, (b) => b.data[0]],
    [`/properties/${casa.id}`, (b) => b.data.offers[0]],
    ['/properties', (b) => b.data.find((p) => p.id === casa.id).offers[0]],
  ]) {
    const r = await http('GET', rota, undefined, tokenLeitura);
    assert.equal(r.status, 200);
    assert.equal('confidentialMinPrice' in pegar(r.body), false, `${rota} não traz o preço mínimo para properties:read`);
    assert.ok(!JSON.stringify(r.body).includes('610000'), `${rota} não vaza o valor`);
    const interno = await http('GET', rota);
    assert.equal(Number(pegar(interno.body).confidentialMinPrice), 610000, `${rota} traz para properties:internal`);
  }
  const patch = await http('PATCH', `/properties/${casa.id}/offers/${o.body.data.id}`, { askingPrice: 690000 }, tokenComum);
  assert.equal(patch.status, 200);
  assert.equal('confidentialMinPrice' in patch.body.data, false, 'a resposta da alteração também não traz');
  assert.equal((await http('PATCH', `/properties/${casa.id}/offers/${o.body.data.id}`, { confidentialMinPrice: 1 }, tokenComum)).status, 403);
});

test('§7 alteração de preço gera histórico e o evento property.price.changed com o imóvel', async () => {
  const casa = await imovel();
  const o = (await http('POST', `/properties/${casa.id}/offers`, { offerType: 'SALE', askingPrice: 400000 })).body.data;
  const p = await http('PATCH', `/properties/${casa.id}/offers/${o.id}`, { askingPrice: 380000, reasonCode: 'NEGOCIACAO' });
  assert.equal(p.status, 200);
  const hist = await withTenantTransaction(tenant, (t) => PropertyPriceHistory.findAll({ where: { offerId: o.id }, order: [['created_at', 'ASC']], transaction: t }));
  assert.deepEqual(hist.map((h) => [h.oldPrice === null ? null : Number(h.oldPrice), Number(h.newPrice), h.reasonCode]), [[null, 400000, 'OFFER_CREATED'], [400000, 380000, 'NEGOCIACAO']]);
  const ev = await withTenantTransaction(tenant, (t) => OutboxEvent.findOne({ where: { eventType: 'property.price.changed', idempotencyKey: `property.price.changed:${hist[1].id}` }, transaction: t }));
  assert.ok(ev, 'evento do livro §14 emitido');
  assert.equal(ev.payloadJson.propertyId, casa.id);
  const tela = await http('GET', `/properties/${casa.id}/price-history`, undefined, tokenLeitura);
  assert.equal(tela.body.data.length, 2, 'histórico visível para quem lê o imóvel');
});
