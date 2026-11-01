'use strict';

// M9-D850 (reabertura F12) — a tela de Usuários cruza GET /users com GET /memberships por `userId`; este teste prova pela API real a forma da resposta que o cruzamento usa.
process.env.PORT = process.env.M9D850_VINCULOS_TEST_PORT || '21850';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startHttp, stopHttp } = require('../_helpers/m9d806Http');

const GRANTS = { 'CI GESTOR': ['users:read', 'memberships:read'] };
let http;
before(async () => { http = await startHttp({ port: process.env.PORT, grants: GRANTS, logins: { gestorA: ['A', 'gestor'] } }); });
after(async () => { await stopHttp(GRANTS); });

test('m9d850 GET /memberships devolve userId camelCase, empresa e papel por vínculo (o cruzamento da tela de Usuários)', async (t) => {
  if (http.skip) return t.skip(http.skip);
  const users = await http.call('gestorA', 'GET', '/users');
  const memberships = await http.call('gestorA', 'GET', '/memberships');
  assert.equal(users.status, 200, JSON.stringify(users.body));
  assert.equal(memberships.status, 200, JSON.stringify(memberships.body));
  const byUser = new Map();
  for (const m of memberships.body.data) byUser.set(m.userId, m);
  assert.ok(users.body.data.length >= 5, 'a empresa de teste tem usuários');
  for (const user of users.body.data) {
    const m = byUser.get(user.id);
    assert.ok(m, `o usuário ${user.name} tem vínculo no cruzamento por userId`);
    assert.equal(m.status, 'ACTIVE');
    assert.ok(m.company && m.company.name, 'o vínculo traz a empresa (nome)');
    assert.ok(m.role && m.role.name, 'o vínculo traz o papel (nome)');
  }
});

test('m9d850 GET /memberships só traz vínculos da empresa ativa (isolamento por empresa)', async (t) => {
  if (http.skip) return t.skip(http.skip);
  const own = await http.call('gestorA', 'GET', '/memberships');
  assert.ok(own.body.data.every((m) => m.companyId === http.tenants.A.companyId), 'só vínculos da empresa ativa');
});
