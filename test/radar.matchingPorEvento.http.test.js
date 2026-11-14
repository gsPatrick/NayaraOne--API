'use strict';

/**
 * CRMX-007 pela rota HTTP do livro (POST /crm/radars, Guia "Criar radar") + despacho do outbox de produção
 * (dispatchPendingEventsForCompany, o mesmo do job a cada 30 s): o radar criado pela API não grava match na requisição; o
 * despacho do evento crm.radar.created grava crm.radar_matches e publica crm.radar.match.created; o mesmo evento despachado de
 * novo não duplica. Grava de verdade: rodar só em banco descartável (scripts/withDisposableDb.js).
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.PORT = process.env.RADAR_EVENTO_HTTP_TEST_PORT || '21648';

require('../app');
const { getSeedTenant, uniqueSuffix, sequelize, withTenantTransaction } = require('./testHelpers');
const { signAccessToken } = require('../src/utils/jwt');
const { dispatchPendingEventsForCompany } = require('../src/engines/events/outbox-dispatcher');
const { OutboxEvent } = require('../src/models');

const PERMS = ['people:create', 'people:read', 'properties:create', 'properties:read', 'properties:update', 'radar:create', 'radar:read', 'radar:update'];
let tenant;
let baseUrl;
let token;

before(async () => {
  tenant = await getSeedTenant();
  token = signAccessToken({ sub: tenant.userId, group_id: tenant.groupId, company_id: tenant.companyId, roles: ['admin'], permissions: PERMS });
  baseUrl = `http://127.0.0.1:${process.env.PORT}/api/v1`;
  await new Promise((resolve) => setTimeout(resolve, 300));
});

after(async () => {
  await sequelize.close();
  process.exit(0);
});

async function http(method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const despachar = () => dispatchPendingEventsForCompany({ id: tenant.groupId }, { id: tenant.companyId }, { limit: 1000 });
const eventos = (where) => withTenantTransaction(tenant, (t) => OutboxEvent.findAll({ where, transaction: t }));

test('ROTA POST /crm/radars: matching por evento no despacho do outbox, idempotente no reenvio', async () => {
  const sfx = uniqueSuffix();
  const city = `RadarEvHttp${sfx}`;
  const pessoa = await http('POST', '/people', { personType: 'PF', legalName: `Cliente Radar Evento HTTP ${sfx}`, allowDuplicate: true });
  assert.equal(pessoa.status, 201, JSON.stringify(pessoa.body));
  const imovel = await http('POST', '/properties', { title: `Radar Ev HTTP ${sfx}`, internalCode: `REH-${sfx}`, propertyType: 'RESIDENTIAL', city, areaTotalM2: 80 });
  assert.equal(imovel.status, 201, JSON.stringify(imovel.body));
  const oferta = await http('POST', `/properties/${imovel.body.data.id}/offers`, { offerType: 'SALE', askingPrice: 350000 });
  assert.equal(oferta.status, 201, JSON.stringify(oferta.body));
  await despachar(); // o que estava pendente (inclusive a oferta, ainda sem radar) sai antes do radar existir

  const radar = await http('POST', '/crm/radars', { personId: pessoa.body.data.id, criteriaJson: { propertyType: 'RESIDENTIAL', offerType: 'SALE', city } });
  assert.equal(radar.status, 201, JSON.stringify(radar.body));
  const radarId = radar.body.data.id;
  assert.deepEqual(radar.body.data.matches.map((m) => m.id), [imovel.body.data.id], 'a resposta mostra o match do momento');

  const [criado] = await eventos({ eventType: 'crm.radar.created', aggregateId: radarId });
  assert.equal(criado.status, 'PENDING', 'o radar publicou o evento no outbox, ainda não despachado');
  let hist = await http('GET', `/radar/${radarId}/match-history`);
  assert.deepEqual(hist.body.data, [], 'nada gravado na requisição');

  await despachar();
  const [despachado] = await eventos({ id: criado.id });
  assert.equal(despachado.status, 'DISPATCHED');
  hist = await http('GET', `/radar/${radarId}/match-history`);
  assert.equal(hist.status, 200);
  assert.deepEqual(hist.body.data.map((h) => h.propertyId), [imovel.body.data.id], 'o despacho gravou o match');
  assert.equal(hist.body.data[0].criteriaFingerprint, criado.payloadJson.criteriaFingerprint);
  const criadosMatch = await eventos({ eventType: 'crm.radar.match.created', aggregateId: hist.body.data[0].id });
  assert.equal(criadosMatch.length, 1, 'crm.radar.match.created publicado');

  // Reenvio do MESMO evento (status volta a PENDING, como num retry do despachante): não duplica nada.
  await withTenantTransaction(tenant, (t) => OutboxEvent.update({ status: 'PENDING' }, { where: { id: criado.id }, transaction: t }));
  await despachar();
  hist = await http('GET', `/radar/${radarId}/match-history`);
  assert.equal(hist.body.data.length, 1, 'reprocesso não duplica o match');
  const todosMatchCreated = await eventos({ eventType: 'crm.radar.match.created', payloadJson: { radarId } });
  assert.equal(todosMatchCreated.length, 1, 'reprocesso não duplica crm.radar.match.created');
  const avisos = await eventos({ eventType: 'radar.matched', aggregateId: radarId });
  assert.equal(avisos.length, 1, 'reprocesso não duplica radar.matched');
});
