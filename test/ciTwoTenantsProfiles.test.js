'use strict';

// Conferência Nayara 18/10/2026, roteiro item 4: ambiente isolado e descartável com fixtures
// fictícias, DOIS tenants e perfis maker/checker/leitura. O seed (scripts/seed-ci-two-tenants.js)
// roda só no workflow do CI, contra o Postgres descartável do job. Este arquivo prova, pelo
// caminho HTTP real (login real com senha → JWT com as permissões efetivas lidas do banco →
// rotas reais com auth + tenant + RLS), que:
//   1. maker não aprova (403 PERMISSION_DENIED — não tem procurement:approve);
//   2. checker não aprova o que ele mesmo solicitou (regra de negócio
//      PURCHASE_REQUEST_SELF_APPROVAL_FORBIDDEN — a segregação não depende só de permissão);
//   3. checker aprova o pedido do maker;
//   4. leitura recebe 403 ao tentar criar, mas consegue ler;
//   5. tenant B não enxerga (lista nem por id) o pedido do tenant A.
// Fora do CI (sem o seed ou sem CI_TENANT_USERS_PASSWORD) os testes são PULADOS com motivo
// explícito — nunca dão falso verde nem quebram a suíte local.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { emailFor, PROFILES } = require('../scripts/seed-ci-two-tenants');
const { sequelize, User } = require('../src/models');

// 21603 (antes 21600, que colidia com test/painelApproverPermissions.test.js — dois arquivos na
// mesma porta derrubam um deles com EADDRINUSE quando o CI roda em paralelo).
process.env.PORT = process.env.CI_TWO_TENANTS_HTTP_TEST_PORT || '21603';

let skipReason = null;
let appLoaded = false;
let baseUrl;
const tokens = {};

before(async () => {
  const password = process.env.CI_TENANT_USERS_PASSWORD;
  if (!password) {
    skipReason = 'CI_TENANT_USERS_PASSWORD ausente — seed de dois tenants só existe no workflow do CI.';
    return;
  }
  const seeded = await User.findOne({ where: { email: emailFor('A', 'maker') } });
  if (!seeded) {
    skipReason = 'Usuários do seed de dois tenants não encontrados — rode scripts/seed-ci-two-tenants.js (o CI roda).';
    return;
  }

  require('../app');
  appLoaded = true;
  baseUrl = `http://127.0.0.1:${process.env.PORT}/api/v1`;
  await new Promise((resolve) => setTimeout(resolve, 300));

  for (const tenantKey of ['A', 'B']) {
    for (const profile of ['maker', 'checker', 'leitura']) {
      const res = await fetch(`${baseUrl}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: emailFor(tenantKey, profile), password }),
      });
      const body = await res.json();
      assert.equal(res.status, 200, `login de ${tenantKey}/${profile} deveria funcionar: ${JSON.stringify(body)}`);
      tokens[`${tenantKey}:${profile}`] = body.data.accessToken;
    }
  }
});

after(async () => {
  await sequelize.close().catch(() => {});
  if (appLoaded) process.exit(0);
});

async function call(who, method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens[who]}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

function newRequestPayload(label) {
  return { notes: `CI dois tenants — ${label}`, items: [{ description: `Item fictício CI ${label}`, quantity: 2 }] };
}

test('CI dois tenants: tokens reais carregam exatamente as permissões de cada perfil', (t) => {
  if (skipReason) return t.skip(skipReason);
  const permsOf = (who) => JSON.parse(Buffer.from(tokens[who].split('.')[1], 'base64').toString()).permissions.sort();
  for (const tenantKey of ['A', 'B']) {
    for (const profile of PROFILES) {
      assert.deepEqual(permsOf(`${tenantKey}:${profile.key}`), [...profile.permissions].sort());
    }
    // Leitura nunca carrega permissão de escrita/aprovação em nenhum módulo.
    assert.ok(permsOf(`${tenantKey}:leitura`).every((code) => code.endsWith(':read')));
  }
});

test('CI dois tenants: maker cria, maker NÃO aprova (403), checker aprova', async (t) => {
  if (skipReason) return t.skip(skipReason);
  const created = await call('A:maker', 'POST', '/procurement/purchase-requests', newRequestPayload('maker-checker'));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.data.id;

  const makerDecides = await call('A:maker', 'POST', `/procurement/purchase-requests/${id}/decide`, { decision: 'APPROVED' });
  assert.equal(makerDecides.status, 403);
  assert.equal(makerDecides.body.error.code, 'PERMISSION_DENIED');

  const checkerDecides = await call('A:checker', 'POST', `/procurement/purchase-requests/${id}/decide`, { decision: 'APPROVED' });
  assert.equal(checkerDecides.status, 200, JSON.stringify(checkerDecides.body));
  assert.equal(checkerDecides.body.data.status, 'APPROVED');
});

test('CI dois tenants: checker com permissão de aprovar NÃO aprova o próprio pedido (regra, não permissão)', async (t) => {
  if (skipReason) return t.skip(skipReason);
  const own = await call('A:checker', 'POST', '/procurement/purchase-requests', newRequestPayload('autoaprovacao'));
  assert.equal(own.status, 201, JSON.stringify(own.body));

  const selfDecides = await call('A:checker', 'POST', `/procurement/purchase-requests/${own.body.data.id}/decide`, { decision: 'APPROVED' });
  assert.equal(selfDecides.status, 403);
  assert.equal(selfDecides.body.error.code, 'PURCHASE_REQUEST_SELF_APPROVAL_FORBIDDEN');
});

test('CI dois tenants: perfil leitura recebe 403 ao criar e consegue listar', async (t) => {
  if (skipReason) return t.skip(skipReason);
  const readerCreates = await call('A:leitura', 'POST', '/procurement/purchase-requests', newRequestPayload('leitura'));
  assert.equal(readerCreates.status, 403);
  assert.equal(readerCreates.body.error.code, 'PERMISSION_DENIED');

  const readerLists = await call('A:leitura', 'GET', '/procurement/purchase-requests');
  assert.equal(readerLists.status, 200);
  assert.ok(Array.isArray(readerLists.body.data));
});

test('CI dois tenants: tenant B não enxerga o pedido do tenant A (nem na lista, nem por id)', async (t) => {
  if (skipReason) return t.skip(skipReason);
  const created = await call('A:maker', 'POST', '/procurement/purchase-requests', newRequestPayload('isolamento'));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const idFromA = created.body.data.id;

  const listB = await call('B:leitura', 'GET', '/procurement/purchase-requests');
  assert.equal(listB.status, 200);
  assert.ok(!listB.body.data.some((r) => r.id === idFromA), 'pedido do tenant A apareceu na lista do tenant B');

  const byIdB = await call('B:leitura', 'GET', `/procurement/purchase-requests/${idFromA}`);
  assert.equal(byIdB.status, 404, `tenant B leu o pedido do tenant A por id: ${JSON.stringify(byIdB.body)}`);

  const decideB = await call('B:checker', 'POST', `/procurement/purchase-requests/${idFromA}/decide`, { decision: 'APPROVED' });
  assert.equal(decideB.status, 404, `checker do tenant B decidiu pedido do tenant A: ${JSON.stringify(decideB.body)}`);

  const stillA = await call('A:leitura', 'GET', `/procurement/purchase-requests/${idFromA}`);
  assert.equal(stillA.status, 200);
  assert.equal(stillA.body.data.status, 'REQUESTED', 'pedido do tenant A não pode ter sido alterado pelo tenant B');
});
