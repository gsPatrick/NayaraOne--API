'use strict';

// M3-17 (contrato: "indicadores do painel calculados pela mesma fonte das listas") + livro §18 ("Corretor visualizar carteira
// alheia — escopo conforme política de equipe"): pela rota, o painel do CRM aplica o MESMO escopo de carteira que a listagem.
// Grava de verdade: rodar só em banco descartável (scripts/withDisposableDb.js).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { portaLivre } = require('./marco9/_helpers/portaLivre');

process.env.PORT = process.env.M3CA_HTTP_TEST_PORT || portaLivre();
require('../app');
const { getSeedTenant, withTenantTransaction, sequelize } = require('./testHelpers');
const { signAccessToken } = require('../src/utils/jwt');
const { createMember, createPerson, createTestProperty } = require('./helpers/m3caCrm');

let tenant;
let baseUrl;
const PERMS = ['people:read', 'crm:opportunities:create', 'crm:opportunities:read', 'crm:opportunities:update', 'crm:dashboard:read', 'crm:proposals:create', 'crm:proposals:read'];
const tokenFor = (userId, extra) => signAccessToken({ sub: userId, group_id: tenant.groupId, company_id: tenant.companyId, roles: ['corretor'], permissions: [...PERMS, ...extra] });

before(async () => {
  if (process.env.DISPOSABLE_DB !== '1') throw new Error('Rode em banco descartável (scripts/withDisposableDb.js).');
  tenant = await getSeedTenant();
  baseUrl = `http://127.0.0.1:${process.env.PORT}/api/v1`;
  await new Promise((resolve) => setTimeout(resolve, 300));
});
after(async () => {
  await sequelize.close();
  process.exit(0);
});

async function http(token, method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
}

test('M3-17: corretor de escopo próprio vê no painel só os números da carteira dele — os mesmos da lista dele; o gestor vê tudo', async () => {
  const { ana, bruno, personId, propertyId } = await withTenantTransaction(tenant, async (t) => ({
    ana: await createMember(tenant, t, { label: 'ana' }),
    bruno: await createMember(tenant, t, { label: 'bruno' }),
    personId: (await createPerson(tenant, t, 'Painel')).id,
    propertyId: (await createTestProperty(tenant, t)).id,
  }));
  const gestor = tokenFor(tenant.userId, ['crm:opportunities:read:all']);
  const ontem = new Date(Date.now() - 86400000).toISOString();
  const cria = async (owner, extra = {}) => {
    const r = await http(gestor, 'POST', '/opportunities', { personId, propertyId, ownerUserId: owner, nextAction: 'Retornar', nextActionDueAt: ontem, ...extra });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.data;
  };
  const anaAberta = await cria(ana);
  const anaGanha = await cria(ana);
  assert.equal((await http(gestor, 'PATCH', `/opportunities/${anaGanha.id}`, { stage: 'WON', wonReason: 'REFERRAL' })).status, 200);
  const brunoAberta = await cria(bruno);
  const brunoPerdida = await cria(bruno);
  assert.equal((await http(gestor, 'PATCH', `/opportunities/${brunoPerdida.id}`, { stage: 'LOST', lostReason: 'COMPETITOR' })).status, 200);
  for (const opp of [anaAberta, brunoAberta, brunoPerdida]) {
    assert.equal((await http(gestor, 'POST', '/crm/proposals', { opportunityId: opp.id, value: 410000, status: 'SENT' })).status, 201);
  }

  const tokenAna = tokenFor(ana, ['crm:opportunities:read:own']);
  const lista = await http(tokenAna, 'GET', '/opportunities');
  assert.equal(lista.status, 200);
  const painel = await http(tokenAna, 'GET', '/crm/dashboard');
  assert.equal(painel.status, 200, JSON.stringify(painel.body));
  const p = painel.body.data;
  assert.equal(p.opportunities.total, lista.body.data.length, 'total do painel = tamanho da lista do corretor');
  assert.equal(p.opportunities.total, 2);
  assert.deepEqual(p.opportunities.byStage, { NEW: 1, WON: 1 });
  assert.equal(p.conversionRate, 1);
  assert.deepEqual(p.staleOpportunities.items.map((i) => i.id), [anaAberta.id], 'só a oportunidade parada da própria carteira');
  assert.equal(p.staleOpportunities.count, 1);
  assert.equal(p.proposals.total, 1, 'só as propostas das oportunidades da carteira dele');
  assert.deepEqual(p.topLostReasons, []);

  const tentando = await http(tokenAna, 'GET', `/crm/dashboard?ownerUserId=${bruno}`);
  assert.equal(tentando.body.data.opportunities.total, 2, 'o filtro ownerUserId não abre a carteira de outro corretor');
  assert.ok(tentando.body.data.staleOpportunities.items.every((i) => i.ownerUserId === ana));

  const geral = await http(gestor, 'GET', '/crm/dashboard');
  const listaGeral = await http(gestor, 'GET', '/opportunities');
  assert.equal(geral.body.data.opportunities.total, listaGeral.body.data.length, 'gestor: painel = lista de toda a empresa');
  const doBruno = await http(gestor, 'GET', `/crm/dashboard?ownerUserId=${bruno}`);
  assert.deepEqual(doBruno.body.data.opportunities.byStage, { NEW: 1, LOST: 1 }, 'gestor filtra a carteira de um corretor');
  assert.equal(doBruno.body.data.proposals.total, 2);
});
