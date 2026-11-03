'use strict';

// R8 (reconferência ao vivo 20/10/2026) — perfil "só leitura" do Financeiro.
//  1. varredura: TODA rota mutável (POST/PATCH/PUT/DELETE) sob /finance/ responde 403
//     PERMISSION_DENIED para quem tem só finance:read (+ leituras de apoio) — nenhuma exige só
//     finance:read por engano nem fica sem permissão;
//  2. o papel do seed (scripts/seed-homo-financeiro-leitura.js) tem só leituras;
//  3. as rotas de leitura continuam respondendo (200) com o mesmo token.
// Roda no banco de dev (só lê; as rotas mutáveis são recusadas ANTES de tocar em dados).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.PORT = process.env.FINANCE_READONLY_HTTP_TEST_PORT || '21651';

const app = require('../app');
const { sequelize, getSeedTenant } = require('./testHelpers');
const { signAccessToken } = require('../src/utils/jwt');
const { ROLE_NAME, PERMISSION_CODES } = require('../scripts/seed-homo-financeiro-leitura');

let tenant;
let token;
const base = () => `http://127.0.0.1:${process.env.PORT}/api/v1`;

before(async () => {
  tenant = await getSeedTenant();
  token = signAccessToken({
    sub: tenant.userId, group_id: tenant.groupId, company_id: tenant.companyId,
    roles: ['HOMO QA — Financeiro (somente leitura)'],
    permissions: PERMISSION_CODES,
  });
  await new Promise((r) => setTimeout(r, 300));
});
after(async () => { await sequelize.close(); process.exit(0); });

// Coleta {method, path} de todas as rotas registradas no app Express, qualquer profundidade.
function collectRoutes(stack, prefix = '') {
  const out = [];
  for (const layer of stack) {
    if (layer.route) {
      for (const method of Object.keys(layer.route.methods)) out.push({ method: method.toUpperCase(), path: prefix + layer.route.path });
    } else if (layer.name === 'router' && layer.handle && layer.handle.stack) {
      out.push(...collectRoutes(layer.handle.stack, prefix));
    }
  }
  return out;
}

test('o papel do seed tem só leituras (nenhuma ação do Financeiro)', () => {
  assert.equal(ROLE_NAME, 'HOMO QA — Financeiro (somente leitura)');
  assert.ok(PERMISSION_CODES.includes('finance:read'));
  for (const code of PERMISSION_CODES) assert.match(code, /:read$/, `${code} não é de leitura`);
  for (const forbidden of ['finance:create', 'finance:update', 'finance:settle', 'finance:approve', 'finance:reconcile', 'finance:bankAccounts', 'finance:chartOfAccounts']) {
    assert.ok(!PERMISSION_CODES.includes(forbidden));
  }
});

test('varredura: toda rota mutável de /finance/* recusa quem só tem finance:read (403 PERMISSION_DENIED)', async () => {
  const mutating = collectRoutes(app._router.stack)
    .filter((r) => r.path.startsWith('/finance/') && ['POST', 'PATCH', 'PUT', 'DELETE'].includes(r.method));
  assert.ok(mutating.length >= 50, `esperava 50+ rotas mutáveis, achei ${mutating.length}`);

  const failures = [];
  for (const route of mutating) {
    const concrete = route.path.replace(/:[A-Za-z]+/g, '00000000-0000-4000-8000-000000000000');
    const res = await fetch(`${base()}${concrete}`, {
      method: route.method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: route.method === 'DELETE' ? undefined : JSON.stringify({}),
    });
    const body = await res.json().catch(() => ({}));
    if (res.status !== 403 || (body.error && body.error.code) !== 'PERMISSION_DENIED') {
      failures.push(`${route.method} ${route.path} -> ${res.status} ${(body.error && body.error.code) || ''}`);
    }
  }
  assert.deepEqual(failures, [], `rotas mutáveis acessíveis só com finance:read:\n${failures.join('\n')}`);
});

test('leituras do Financeiro seguem funcionando com o mesmo token (200)', async () => {
  for (const path of ['/finance/entries', '/finance/bank-accounts', '/finance/cost-centers', '/finance/anomaly-cases', '/finance/reconciliations']) {
    const res = await fetch(`${base()}${path}`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(res.status, 200, `${path} -> ${res.status}`);
  }
});
