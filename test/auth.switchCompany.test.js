'use strict';

// R9 (reconferência ao vivo 20/10/2026) — "Trocar de empresa" ficava desativado. Prova, pelo
// caminho HTTP real (login com senha -> tokens reais -> rotas reais), que:
//   1. GET /auth/companies lista só as empresas com vínculo ATIVO do usuário;
//   2. POST /auth/switch-company com vínculo válido devolve novos tokens da outra empresa;
//   3. empresa sem vínculo (existente ou inexistente) -> 403 NO_ACTIVE_MEMBERSHIP;
//   4. o token antigo deixa de valer (sessão revogada) e, mesmo que valesse, só enxergaria a empresa A;
//   5. com o token novo, um lançamento da empresa A responde 404 (isolamento).
// Fixtures COMMITADAS (login/HTTP usam transações próprias): rode com
//   node scripts/withDisposableDb.js -- node --test test/auth.switchCompany.test.js
// Fora de banco descartável (DISPOSABLE_DB=1 ou CI, cujo Postgres é efêmero), o teste é pulado.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');

process.env.PORT = process.env.AUTH_SWITCH_HTTP_TEST_PORT || '21640';

const skip = (process.env.DISPOSABLE_DB || process.env.CI) ? false : 'requer banco descartável (scripts/withDisposableDb.js ou o CI)';

let ctx = {};

before(async () => {
  if (skip) return;
  require('../app');
  const { sequelize, getSeedTenant, withTenantTransaction, uniqueSuffix, createTestCostCenter } = require('./testHelpers');
  const { Company, Role, UserMembership, User, RolePermission, Permission } = require('../src/models');
  const financialEntriesService = require('../src/features/finance/financialEntries.service');
  const tenant = await getSeedTenant();
  const suffix = uniqueSuffix();
  const password = `Sw!${suffix}aA`;
  const user = await User.create({
    name: `HOMO QA R9 ${suffix}`, email: `homo-qa-r9-${suffix}@nayaraone.dev`,
    passwordHash: await bcrypt.hash(password, 4), status: 'ACTIVE',
  });
  const perms = await Permission.findAll({ where: { code: ['finance:read'] } });
  async function company(name, withMembership) {
    return withTenantTransaction({ ...tenant, companyId: null }, async (t) => {
      const c = await Company.create({ groupId: tenant.groupId, name, status: 'ACTIVE' }, { transaction: t });
      await sequelize.query("SELECT set_config('app.company_id', :c, true)", { replacements: { c: c.id }, transaction: t });
      const role = await Role.create({ groupId: tenant.groupId, companyId: c.id, name: `R9 Leitor ${suffix}`, isSystem: false }, { transaction: t });
      for (const p of perms) await RolePermission.create({ groupId: tenant.groupId, companyId: c.id, roleId: role.id, permissionId: p.id }, { transaction: t });
      if (withMembership) {
        await UserMembership.create({ groupId: tenant.groupId, companyId: c.id, userId: user.id, roleId: role.id, status: 'ACTIVE' }, { transaction: t });
      }
      return c;
    });
  }
  const A = await company(`R9 Empresa A ${suffix}`, true);
  const B = await company(`R9 Empresa B ${suffix}`, true);
  const C = await company(`R9 Empresa C sem vinculo ${suffix}`, false);
  const entryA = await withTenantTransaction({ ...tenant, companyId: A.id }, async (t) => {
    const cc = await createTestCostCenter({ ...tenant, companyId: A.id }, t);
    return financialEntriesService.createFinancialEntry(
      { groupId: tenant.groupId, companyId: A.id, nature: 'PAYABLE', entryType: 'DEBIT', amount: 10, description: 'R9 lanc A', costCenterId: cc.id, idempotencyKey: `r9-${suffix}` },
      tenant.userId, t
    );
  });
  ctx = { baseUrl: `http://127.0.0.1:${process.env.PORT}/api/v1`, email: user.email, password, A, B, C, entryA, sequelize };
  await new Promise((r) => setTimeout(r, 300));
});

after(async () => {
  if (ctx.sequelize) await ctx.sequelize.close().catch(() => {});
  if (!skip) process.exit(0);
});

async function call(method, path, token, body) {
  const res = await fetch(`${ctx.baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json, data: json.data, code: json.error && json.error.code };
}

test('R9: lista, troca, recusa sem vínculo, revoga o token antigo e isola dados', { skip }, async () => {
  const login = await call('POST', '/auth/login', null, { email: ctx.email, password: ctx.password, companyId: ctx.A.id });
  assert.equal(login.status, 200);
  const tokenA = login.data.accessToken;
  assert.equal(login.data.companyId, ctx.A.id);

  const list = await call('GET', '/auth/companies', tokenA);
  assert.equal(list.status, 200);
  const ids = list.data.companies.map((c) => c.id).sort();
  assert.deepEqual(ids, [ctx.A.id, ctx.B.id].sort(), 'só empresas com vínculo ativo; C fica de fora');
  assert.equal(list.data.companies.find((c) => c.id === ctx.A.id).current, true);
  assert.ok(list.data.companies.every((c) => c.name && c.roles.length === 1));

  // Antes: lançamento de A visível com o token de A.
  assert.equal((await call('GET', `/finance/entries/${ctx.entryA.id}`, tokenA)).status, 200);

  // Sem vínculo / inexistente / ausente / mesma empresa.
  for (const id of [ctx.C.id, '00000000-0000-4000-8000-000000000000']) {
    const r = await call('POST', '/auth/switch-company', tokenA, { companyId: id });
    assert.equal(r.status, 403);
    assert.equal(r.code, 'NO_ACTIVE_MEMBERSHIP');
  }
  assert.equal((await call('POST', '/auth/switch-company', tokenA, {})).status, 400);
  assert.equal((await call('POST', '/auth/switch-company', tokenA, { companyId: ctx.A.id })).status, 400);
  assert.equal((await call('POST', '/auth/switch-company', null, { companyId: ctx.B.id })).status, 401);
  assert.equal((await call('GET', '/auth/companies', null)).status, 401);

  // Troca válida.
  const sw = await call('POST', '/auth/switch-company', tokenA, { companyId: ctx.B.id });
  assert.equal(sw.status, 200, JSON.stringify(sw.body));
  assert.equal(sw.data.companyId, ctx.B.id);
  assert.deepEqual(sw.data.permissions, ['finance:read']);
  const tokenB = sw.data.accessToken;
  assert.notEqual(tokenB, tokenA);

  // Token antigo morreu (sessão revogada).
  const old = await call('GET', '/auth/companies', tokenA);
  assert.equal(old.status, 401);
  assert.equal(old.code, 'SESSION_INVALID');

  // Token novo: lançamento de A não existe para B (404) e a lista de B não o contém.
  assert.equal((await call('GET', `/finance/entries/${ctx.entryA.id}`, tokenB)).status, 404);
  const entriesB = await call('GET', '/finance/entries', tokenB);
  assert.equal(entriesB.status, 200);
  assert.ok(!JSON.stringify(entriesB.data).includes(ctx.entryA.id));

  // E de volta para A com o token de B.
  const back = await call('POST', '/auth/switch-company', tokenB, { companyId: ctx.A.id });
  assert.equal(back.status, 200);
  assert.equal((await call('GET', `/finance/entries/${ctx.entryA.id}`, back.data.accessToken)).status, 200);
});
