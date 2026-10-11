'use strict';

// CICLO 3 (verificação cética do Marco 3, 11/10/2026): toda a cobertura de testes do Marco 3
// até aqui chamava os services diretamente — nenhum arquivo batia com requisição HTTP real
// contra o Express app (auth JWT real + middleware de tenant real + rotas reais), ao contrário
// do padrão já usado em `construction.httpRoutes.test.js` (Marco 6). Este arquivo fecha essa
// lacuna para o núcleo do Marco 3: pessoa -> merge -> imóvel -> 2 ofertas (SALE+RENT) ->
// oportunidade -> interação -> LOST -> radar, tudo via fetch nativo contra o app real.
//
// Mesmo padrão de `construction.httpRoutes.test.js`: fixa PORT antes do require('../app') para
// não colidir com o processo de dev (porta 3000), e limpa tudo no after() em ordem reversa de FK.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.PORT = process.env.MARCO3_HTTP_TEST_PORT || '34592';

const app = require('../app');
const { getSeedTenant, uniqueSuffix } = require('./testHelpers');
const { signAccessToken } = require('../src/utils/jwt');
const { Person, Property, PropertyOffer, Opportunity, Message, PropertyRadar } = require('../src/models');

let tenant;
let baseUrl;
let token;

const createdPersonIds = [];
const createdPropertyIds = [];
const createdOfferIds = [];
const createdOpportunityIds = [];
const createdMessageIds = [];
const createdRadarIds = [];

before(async () => {
  tenant = await getSeedTenant();

  token = signAccessToken({
    sub: tenant.userId,
    group_id: tenant.groupId,
    company_id: tenant.companyId,
    roles: ['admin'],
    permissions: [
      'people:create', 'people:read', 'people:update',
      'properties:create', 'properties:read', 'properties:update',
      'crm:opportunities:create', 'crm:opportunities:read', 'crm:opportunities:update',
      'crm:messages:create', 'crm:messages:read',
      'radar:create', 'radar:read',
    ],
  });

  baseUrl = `http://127.0.0.1:${process.env.PORT}/api/v1`;
  await new Promise((resolve) => setTimeout(resolve, 300));
});

after(async () => {
  if (createdRadarIds.length > 0) await PropertyRadar.destroy({ where: { id: createdRadarIds }, force: true });
  if (createdMessageIds.length > 0) await Message.destroy({ where: { id: createdMessageIds }, force: true });
  if (createdOpportunityIds.length > 0) await Opportunity.destroy({ where: { id: createdOpportunityIds }, force: true });
  if (createdOfferIds.length > 0) await PropertyOffer.destroy({ where: { id: createdOfferIds }, force: true });
  if (createdPropertyIds.length > 0) await Property.destroy({ where: { id: createdPropertyIds }, force: true });
  if (createdPersonIds.length > 0) await Person.destroy({ where: { id: createdPersonIds }, force: true });

  const { sequelize } = require('./testHelpers');
  await sequelize.close();
  // Sem referência ao server HTTP real criado dentro de `app.js` (não exportado, `app.listen`
  // incondicional) — mesmo padrão de `construction.httpRoutes.test.js`: o encerramento do
  // processo do test runner (um processo por arquivo) libera a porta.
  process.exit(0);
});

async function http(method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

test('Marco 3 ponta a ponta via HTTP real: pessoa -> merge -> imóvel -> 2 ofertas -> oportunidade -> interação -> LOST -> radar', async () => {
  const suffix = uniqueSuffix();

  // 1. Criar pessoa (canônica) e uma segunda (a ser absorvida no merge).
  const p1 = await http('POST', '/people', {
    personType: 'PF',
    legalName: `Cliente HTTP ${suffix}`,
    allowDuplicate: true,
  });
  assert.equal(p1.status, 201, JSON.stringify(p1.body));
  createdPersonIds.push(p1.body.data.id);

  const p2 = await http('POST', '/people', {
    personType: 'PF',
    legalName: `Cliente HTTP Duplicado ${suffix}`,
    allowDuplicate: true,
  });
  assert.equal(p2.status, 201, JSON.stringify(p2.body));
  createdPersonIds.push(p2.body.data.id);

  // 2. Merge real via rota HTTP (POST /people/:id/merge).
  const merge = await http('POST', `/people/${p1.body.data.id}/merge`, { absorbedId: p2.body.data.id });
  assert.equal(merge.status, 200, JSON.stringify(merge.body));

  // 3. Criar imóvel.
  const property = await http('POST', '/properties', {
    title: `Imóvel HTTP ${suffix}`,
    internalCode: `IC-HTTP-${suffix}`,
    propertyType: 'RESIDENTIAL',
  });
  assert.equal(property.status, 201, JSON.stringify(property.body));
  createdPropertyIds.push(property.body.data.id);

  // 4. Duas ofertas simultâneas no MESMO imóvel — prova HTTP real de CRMX-004.
  const offerSale = await http('POST', `/properties/${property.body.data.id}/offers`, {
    offerType: 'SALE',
    askingPrice: 500000,
  });
  assert.equal(offerSale.status, 201, JSON.stringify(offerSale.body));
  createdOfferIds.push(offerSale.body.data.id);

  const offerRent = await http('POST', `/properties/${property.body.data.id}/offers`, {
    offerType: 'RENT',
    askingPrice: 3000,
  });
  assert.equal(offerRent.status, 201, JSON.stringify(offerRent.body));
  createdOfferIds.push(offerRent.body.data.id);

  const offersList = await http('GET', `/properties/${property.body.data.id}/offers`);
  assert.equal(offersList.status, 200);
  const activeOffers = offersList.body.data.filter((o) => o.status === 'ACTIVE');
  assert.equal(activeOffers.length, 2, 'as duas ofertas (SALE+RENT) devem estar ACTIVE simultaneamente, sem duplicar o imóvel');

  // 5. Criar oportunidade vinculada à pessoa/imóvel.
  const opportunity = await http('POST', '/opportunities', {
    personId: p1.body.data.id,
    propertyId: property.body.data.id,
    nextAction: 'Ligar para o cliente',
    nextActionDueAt: new Date(Date.now() + 86400000).toISOString(),
  });
  assert.equal(opportunity.status, 201, JSON.stringify(opportunity.body));
  createdOpportunityIds.push(opportunity.body.data.id);

  // 6. Registrar interação (crm.interaction.recorded).
  const message = await http('POST', '/messages', {
    personId: p1.body.data.id,
    opportunityId: opportunity.body.data.id,
    direction: 'OUTBOUND',
    authorType: 'EMPLOYEE',
    channel: 'WHATSAPP',
    body: 'Mensagem de teste via HTTP real.',
  });
  assert.equal(message.status, 201, JSON.stringify(message.body));
  createdMessageIds.push(message.body.data.id);

  // 7. Marcar CLOSED_LOST com motivo (CRM-TS-008, via rota HTTP real de update).
  const lost = await http('PATCH', `/opportunities/${opportunity.body.data.id}`, {
    stage: 'CLOSED_LOST',
    lostReason: 'PRICE_TOO_HIGH',
  });
  assert.equal(lost.status, 200, JSON.stringify(lost.body));
  assert.equal(lost.body.data.stage, 'CLOSED_LOST');

  // 8. Criar radar vinculado à pessoa.
  const radar = await http('POST', '/radar', {
    personId: p1.body.data.id,
    criteriaJson: { required: { city: 'Teste' }, preferences: [] },
  });
  assert.equal(radar.status, 201, JSON.stringify(radar.body));
  createdRadarIds.push(radar.body.data.id);

  const radarMatches = await http('GET', `/radar/${radar.body.data.id}/matches`);
  assert.equal(radarMatches.status, 200);
});

test('Marco 3 HTTP real: LOST sem motivo é bloqueado pela rota real (CRM-TS-008 ponta a ponta)', async () => {
  const suffix = uniqueSuffix();

  const person = await http('POST', '/people', { personType: 'PF', legalName: `Cliente LOST ${suffix}`, allowDuplicate: true });
  assert.equal(person.status, 201);
  createdPersonIds.push(person.body.data.id);

  const opportunity = await http('POST', '/opportunities', {
    personId: person.body.data.id,
    nextAction: 'Follow-up',
    nextActionDueAt: new Date(Date.now() + 86400000).toISOString(),
  });
  assert.equal(opportunity.status, 201);
  createdOpportunityIds.push(opportunity.body.data.id);

  const lostNoReason = await http('PATCH', `/opportunities/${opportunity.body.data.id}`, { stage: 'CLOSED_LOST' });
  assert.ok(lostNoReason.status >= 400, 'CLOSED_LOST sem motivo deveria ser rejeitado pela rota HTTP real');
  assert.equal(lostNoReason.body?.error?.code, 'OPPORTUNITY_OUTCOME_REASON_REQUIRED');
});
