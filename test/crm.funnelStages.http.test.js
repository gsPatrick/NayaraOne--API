'use strict';

// Livro do Marco 3 §10 pela rota: o funil do CRM aceita só os estágios do livro (POST/PATCH /opportunities).
// Grava de verdade: rodar só em banco descartável (scripts/withDisposableDb.js).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.PORT = process.env.M3_FUNNEL_HTTP_PORT || '21618';

require('../app');
const { getSeedTenant, uniqueSuffix, sequelize } = require('./testHelpers');
const { signAccessToken } = require('../src/utils/jwt');

let baseUrl;
let token;
const FUTURE = () => new Date(Date.now() + 86400000).toISOString();

before(async () => {
  const tenant = await getSeedTenant();
  token = signAccessToken({
    sub: tenant.userId,
    group_id: tenant.groupId,
    company_id: tenant.companyId,
    roles: ['admin'],
    permissions: ['people:create', 'people:read', 'crm:opportunities:create', 'crm:opportunities:read', 'crm:opportunities:read:all', 'crm:opportunities:update'],
  });
  baseUrl = `http://127.0.0.1:${process.env.PORT}/api/v1`;
  await new Promise((resolve) => setTimeout(resolve, 300));
});

after(async () => {
  await sequelize.close();
  process.exit(0);
});

async function http(method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

test('ROTA funil do livro: estágio do livro aceito, WON normalizado com motivo, estágio fora do livro recusado com OPPORTUNITY_STAGE_INVALID', async () => {
  const p = await http('POST', '/people', { personType: 'PF', legalName: `Funil HTTP ${uniqueSuffix()}`, allowDuplicate: true });
  assert.equal(p.status, 201, JSON.stringify(p.body));
  const personId = p.body.data.id;

  const semEstagio = await http('POST', '/opportunities', { personId, nextAction: 'Ligar', nextActionDueAt: FUTURE() });
  assert.equal(semEstagio.status, 201, JSON.stringify(semEstagio.body));
  assert.equal(semEstagio.body.data.stage, 'NEW');

  const visita = await http('POST', '/opportunities', { personId, stage: 'VISIT_SCHEDULED', nextAction: 'Confirmar visita', nextActionDueAt: FUTURE() });
  assert.equal(visita.status, 201, JSON.stringify(visita.body));
  assert.equal(visita.body.data.stage, 'VISIT_SCHEDULED');

  const inventado = await http('POST', '/opportunities', { personId, stage: 'NOVO', nextAction: 'Ligar', nextActionDueAt: FUTURE() });
  assert.equal(inventado.status, 400);
  assert.equal(inventado.body.error.code, 'OPPORTUNITY_STAGE_INVALID');
  assert.match(inventado.body.error.message, /VISIT_SCHEDULED/);

  const mudancaInvalida = await http('PATCH', `/opportunities/${visita.body.data.id}`, { stage: 'CONTATO' });
  assert.equal(mudancaInvalida.status, 400);
  assert.equal(mudancaInvalida.body.error.code, 'OPPORTUNITY_STAGE_INVALID');

  const proposta = await http('PATCH', `/opportunities/${visita.body.data.id}`, { stage: 'PROPOSAL' });
  assert.equal(proposta.status, 200, JSON.stringify(proposta.body));
  assert.equal(proposta.body.data.stage, 'PROPOSAL');

  const semMotivo = await http('PATCH', `/opportunities/${visita.body.data.id}`, { stage: 'WON' });
  assert.equal(semMotivo.status, 422);
  assert.equal(semMotivo.body.error.code, 'OPPORTUNITY_OUTCOME_REASON_REQUIRED');

  const ganho = await http('PATCH', `/opportunities/${visita.body.data.id}`, { stage: 'WON', wonReason: 'PRICE_ACCEPTED' });
  assert.equal(ganho.status, 200, JSON.stringify(ganho.body));
  assert.equal(ganho.body.data.stage, 'CLOSED_WON');

  const filtro = await http('GET', '/opportunities?stage=WON');
  assert.equal(filtro.status, 200);
  const lista = Array.isArray(filtro.body.data) ? filtro.body.data : filtro.body.data.items || filtro.body.data.rows || [];
  assert.ok(lista.some((o) => o.id === visita.body.data.id), 'filtro pelo nome do livro (WON) acha a oportunidade ganha');
});
