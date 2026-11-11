'use strict';

/**
 * Marco 3 §14 — carrinho de imóveis (verificação independente de 11/11/2026, CAD-14). HTTP real; só em banco descartável.
 *  - a validade do link vem do parâmetro da empresa (crm.cart.link_expiration_days; antes, 7 dias fixos) ou de uma data futura;
 *  - o clique confere a expiração e se o imóvel está no carrinho (antes registrava clique em link expirado e em imóvel de fora);
 *  - visualização e clique ficam no rastreio (crm.cart_events, append-only) e a tela lê carrinhos, versões, link e rastreio
 *    pela oportunidade (GET /opportunities/:id/carts).
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.PORT = process.env.M3IM_CARRINHO_HTTP_PORT || '36104';

require('../app');
const { getSeedTenant, withTenantTransaction, uniqueSuffix, sequelize } = require('./testHelpers');
const { signAccessToken } = require('../src/utils/jwt');
const { OutboxEvent } = require('../src/models');

let tenant;
let baseUrl;
let token;
const DIA = 86400000;
const FUTURE = () => new Date(Date.now() + 2 * DIA).toISOString();

before(async () => {
  tenant = await getSeedTenant();
  token = signAccessToken({
    sub: tenant.userId, group_id: tenant.groupId, company_id: tenant.companyId, roles: ['admin'],
    permissions: ['people:create', 'people:read', 'crm:opportunities:create', 'crm:opportunities:read', 'crm:opportunities:update', 'properties:create', 'properties:read', 'settings:read', 'settings:update'],
  });
  baseUrl = `http://127.0.0.1:${process.env.PORT}/api/v1`;
  await new Promise((resolve) => setTimeout(resolve, 300));
});

after(async () => {
  await sequelize.close();
  process.exit(0);
});

async function http(method, p, body, auth = true) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(p.startsWith('http') ? p : `${baseUrl}${p}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function cenario() {
  const s = uniqueSuffix();
  const pessoa = await http('POST', '/people', { personType: 'PF', legalName: `Cliente carrinho ${s}`, allowDuplicate: true });
  const op = await http('POST', '/opportunities', { personId: pessoa.body.data.id, stage: 'NEW', nextAction: 'Enviar opções', nextActionDueAt: FUTURE() });
  assert.equal(op.status, 201, JSON.stringify(op.body));
  const imoveis = [];
  for (let i = 0; i < 3; i += 1) {
    const r = await http('POST', '/properties', { title: `Casa ${i} ${s}`, internalCode: `CR-${i}-${s}`, propertyType: 'RESIDENTIAL', city: 'Campinas', state: 'SP' });
    imoveis.push(r.body.data);
  }
  return { opportunity: op.body.data, imoveis };
}

const eventosDoRastreio = (cartId) => withTenantTransaction(tenant, (t) => sequelize.query('SELECT event_type, property_id, version_number FROM crm.cart_events WHERE cart_id = :id ORDER BY occurred_at', { replacements: { id: cartId }, transaction: t }).then(([r]) => r));

test('validade do link: parâmetro da empresa (padrão 7 dias) ou data futura; data passada é recusada', async () => {
  const chave = 'crm.cart.link_expiration_days';
  const { opportunity, imoveis } = await cenario();
  const padrao = await http('POST', `/opportunities/${opportunity.id}/carts`, { propertyIds: [imoveis[0].id] });
  assert.equal(padrao.status, 201, JSON.stringify(padrao.body));
  const dias = (iso) => Math.round((new Date(iso).getTime() - Date.now()) / DIA);
  assert.equal(dias(padrao.body.data.expiresAt), 7);
  try {
    assert.equal((await http('PUT', `/settings/${chave}`, { value: 3 })).status, 200);
    const tres = await http('POST', `/opportunities/${opportunity.id}/carts`, { propertyIds: [imoveis[0].id] });
    assert.equal(dias(tres.body.data.expiresAt), 3);
    assert.equal((await http('PUT', `/settings/${chave}`, { value: 0 })).status, 400);
  } finally {
    await http('PUT', `/settings/${chave}`, { value: 7 });
  }
  const passado = await http('POST', `/opportunities/${opportunity.id}/carts`, { propertyIds: [imoveis[0].id], expiresAt: new Date(Date.now() - DIA).toISOString() });
  assert.equal(passado.status, 400);
  assert.equal(passado.body.error.code, 'CART_VALIDATION');
});

test('clique confere a expiração e se o imóvel está na versão atual; nada é registrado quando recusa', async () => {
  const { opportunity, imoveis } = await cenario();
  const cart = (await http('POST', `/opportunities/${opportunity.id}/carts`, { propertyIds: [imoveis[0].id, imoveis[1].id] })).body.data;
  await http('PATCH', `/carts/${cart.id}/items`, { propertyIds: [imoveis[0].id] }); // v2 sem o imóvel 1
  const token = (await http('POST', `/carts/${cart.id}/share-link`)).body.data.token;
  const publico = `${baseUrl}/crm/carts/public/${token}`;

  const visto = await http('GET', publico, undefined, false);
  assert.equal(visto.status, 200);
  assert.equal(visto.body.data.version, 2);
  const ok = await http('POST', `${publico}/properties/${imoveis[0].id}/click`, undefined, false);
  assert.equal(ok.status, 200);
  const fora = await http('POST', `${publico}/properties/${imoveis[2].id}/click`, undefined, false);
  assert.equal(fora.status, 404);
  assert.equal(fora.body.error.code, 'CART_PROPERTY_NOT_IN_CART');
  const daVersaoAnterior = await http('POST', `${publico}/properties/${imoveis[1].id}/click`, undefined, false);
  assert.equal(daVersaoAnterior.status, 404, 'só conta imóvel da versão enviada agora');

  await withTenantTransaction(tenant, (t) => sequelize.query("UPDATE crm.carts SET expires_at = now() - interval '1 minute' WHERE id = :id", { replacements: { id: cart.id }, transaction: t }));
  const expirado = await http('POST', `${publico}/properties/${imoveis[0].id}/click`, undefined, false);
  assert.equal(expirado.status, 422);
  assert.equal(expirado.body.error.code, 'CART_SHARE_LINK_EXPIRED');

  const rastreio = await eventosDoRastreio(cart.id);
  assert.deepEqual(rastreio.map((e) => [e.event_type, e.property_id, e.version_number]), [['VIEWED', null, 2], ['PROPERTY_CLICKED', imoveis[0].id, 2]]);
  const cliques = await withTenantTransaction(tenant, (t) => OutboxEvent.count({ where: { aggregateId: cart.id, eventType: 'crm.cart.property_clicked' }, transaction: t }));
  assert.equal(cliques, 1, 'evento para o CRM só do clique válido');
});

test('tela do carrinho: GET /opportunities/:id/carts traz versões com os imóveis, link, status efetivo e rastreio', async () => {
  const { opportunity, imoveis } = await cenario();
  const cart = (await http('POST', `/opportunities/${opportunity.id}/carts`, { propertyIds: [imoveis[0].id] })).body.data;
  await http('PATCH', `/carts/${cart.id}/items`, { propertyIds: [imoveis[0].id, imoveis[1].id] });
  const token = (await http('POST', `/carts/${cart.id}/share-link`)).body.data.token;
  const publico = `${baseUrl}/crm/carts/public/${token}`;
  await http('GET', publico, undefined, false);
  await http('GET', publico, undefined, false);
  await http('POST', `${publico}/properties/${imoveis[1].id}/click`, undefined, false);

  const r = await http('GET', `/opportunities/${opportunity.id}/carts`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.length, 1);
  const c = r.body.data[0];
  assert.equal(c.status, 'ACTIVE');
  assert.equal(c.currentVersion, 2);
  assert.deepEqual(c.versions.map((v) => v.properties.map((p) => p.title)), [[imoveis[0].title], [imoveis[0].title, imoveis[1].title]]);
  assert.equal(c.shareLink.token, token);
  assert.equal(c.tracking.views, 2);
  assert.equal(c.tracking.clicks, 1);
  assert.equal(c.tracking.clicksByProperty[imoveis[1].id], 1);
  assert.equal(c.tracking.viewsByVersion[2], 2);

  await withTenantTransaction(tenant, (t) => sequelize.query("UPDATE crm.carts SET expires_at = now() - interval '1 minute' WHERE id = :id", { replacements: { id: cart.id }, transaction: t }));
  assert.equal((await http('GET', `/opportunities/${opportunity.id}/carts`)).body.data[0].status, 'EXPIRED');

  await assert.rejects(
    () => withTenantTransaction(tenant, (t) => sequelize.query('DELETE FROM crm.cart_events WHERE cart_id = :id', { replacements: { id: cart.id }, transaction: t })),
    /permission denied|append-only/i,
    'rastreio é append-only'
  );
});
