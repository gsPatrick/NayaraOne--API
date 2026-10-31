'use strict';

// M9-D904 §3.5 — o roteamento é decidido no login pela flag do setor resolvida (flags.resolve): quem está no canary opera no sistema novo, os demais seguem no antigo. Banco descartável.
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d904Env');
const { routeAtLogin, routeForLogin } = require('../../../src/features/migration-v2/canary/canary.login');
const { selectedUsers } = require('../../../src/features/migration-v2/canary/canary.selection');

let A;
const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
before(async () => { if (env.DISPOSABLE) { A = (await env.loadTenants()).A; await env.cleanup(A); } });
afterEach(async () => { if (env.DISPOSABLE) await env.cleanup(A); });
after(async () => { await env.sequelize.close(); });

const route = (userId) => env.openTenantTx(A, (tx) => routeAtLogin(env.tenantOf(A), userId, tx));
const routeAll = async (users) => Object.fromEntries(await Promise.all(users.map(async (id) => [id, (await route(id)).newSystem])));
const inNew = (map) => Object.keys(map).filter((id) => map[id]).sort();

test('m9d904 etapa 25% de 20 usuários: exatamente 5 operam no sistema novo no login, sempre os mesmos, e 50% mantém os 5', { skip: skip() }, async () => {
  const users = await env.addSectorUsers(A, 'ATENDIMENTO', 20);
  await env.setEntities(A, 'ATENDIMENTO', ['QA904_LEAD']);
  assert.deepEqual(inNew(await routeAll(users)), [], 'sem flag, todos no sistema antigo');
  await env.advance(A, 'ATENDIMENTO'); await env.advance(A, 'ATENDIMENTO');
  const at25 = inNew(await routeAll(users));
  assert.equal(at25.length, 5);
  assert.deepEqual(at25, [...selectedUsers(users, 25)].sort(), 'os mesmos que a seleção por hash escolhe');
  assert.deepEqual(inNew(await routeAll(users)), at25, 'estável entre logins');
  await env.advance(A, 'ATENDIMENTO');
  const at50 = inNew(await routeAll(users));
  assert.equal(at50.length, 10);
  assert.ok(at25.every((id) => at50.includes(id)), '50% mantém os 5 de 25%');
  const sample = await route(at25[0]);
  assert.deepEqual(sample.sectors, [{ sector: 'ATENDIMENTO', percent: 50, newSystem: true }]);
  await env.advance(A, 'ATENDIMENTO');
  assert.equal(inNew(await routeAll(users)).length, 20, '100%: o setor todo');
  await env.rollback(A, 'ATENDIMENTO', { reason: 'volta para o antigo' });
  assert.deepEqual(inNew(await routeAll(users)), [], 'rollback: todos de volta ao sistema antigo');
});

test('m9d904 usuário sem setor, ou de setor que não está no canary, continua no sistema antigo', { skip: skip() }, async () => {
  const atend = await env.addSectorUsers(A, 'ATENDIMENTO', 6);
  const obras = await env.addSectorUsers(A, 'OBRAS', 6);
  await env.setEntities(A, 'ATENDIMENTO', ['QA904_LEAD']);
  for (let i = 0; i < 4; i += 1) await env.advance(A, 'ATENDIMENTO');
  assert.equal(inNew(await routeAll(atend)).length, 6);
  assert.deepEqual(inNew(await routeAll(obras)), [], 'obras não foi ativado');
  const semSetor = await env.committedUser(A);
  assert.deepEqual(await route(semSetor.id), { newSystem: false, sectors: [] });
});

test('m9d904 falha ao ler o registro no login não derruba o login: o usuário segue no sistema antigo', { skip: skip() }, async () => {
  const users = await env.addSectorUsers(A, 'ATENDIMENTO', 2);
  const { flags } = require('../../../src/features/core-governance/feature-flags');
  const original = flags.resolve;
  flags.resolve = async () => { throw new Error('registro fora do ar'); };
  try {
    const out = await env.openTenantTx(A, async (tx) => ({
      result: await routeForLogin(env.tenantOf(A), users[0], tx),
      usable: await env.sequelize.query('SELECT 1 AS ok', { transaction: tx, type: 'SELECT' }),
    }));
    assert.equal(out.result.newSystem, false);
    assert.equal(out.result.error, 'CANARY_ROUTE_UNAVAILABLE');
    assert.equal(out.usable[0].ok, 1, 'a transação do login segue utilizável');
  } finally { flags.resolve = original; }
});
