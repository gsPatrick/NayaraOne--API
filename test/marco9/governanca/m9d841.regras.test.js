'use strict';

// M9-D841 — regras do catálogo e da deprecação no banco descartável: responsável e prazo obrigatórios, origem dos consumidores (credencial da M9-D844) e isolamento entre empresas.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d841Env');

let A;
let B;
const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
const auditCount = async (tenant, action) => (await env.auditOf(tenant, action)).length;

before(async () => { if (!env.DISPOSABLE) return; ({ A, B } = await env.loadTenants()); await env.cleanApi(); });
after(async () => { if (env.DISPOSABLE) await env.cleanApi(); });

test('m9d841 deprecação sem owner recusada', { skip: skip() }, async () => {
  const before422 = await auditCount(A, 'api.deprecation.announced');
  const err = await env.failure(env.deprecate(A, { target: 'MAJOR:1', sunsetAt: env.isoIn(90) }));
  assert.deepEqual([err.status, err.code, err.message], [422, 'GOV_API_OWNER_REQUIRED', 'Informe o responsável pela deprecação.']);
  const blank = await env.failure(env.deprecate(A, { target: 'MAJOR:1', sunsetAt: env.isoIn(90), ownerUserId: '  ' }));
  assert.equal(blank.code, 'GOV_API_OWNER_REQUIRED');
  const semPrazo = await env.failure(env.deprecate(A, env.asOwner(A, { target: 'MAJOR:1' })));
  assert.deepEqual([semPrazo.status, semPrazo.code], [422, 'GOV_API_SUNSET_REQUIRED'], 'sem sunset_at também é 422');
  const stranger = await env.failure(env.deprecate(A, { target: 'MAJOR:1', sunsetAt: env.isoIn(90), ownerUserId: B.userId }));
  assert.deepEqual([stranger.status, stranger.code], [422, 'GOV_API_OWNER_INVALID'], 'responsável de outra empresa não vale');
  const target = await env.failure(env.deprecate(A, env.asOwner(A, { target: 'v1', sunsetAt: env.isoIn(90) })));
  assert.equal(target.code, 'GOV_API_TARGET_INVALID');
  assert.equal((await env.adminQuery('SELECT count(*)::int AS n FROM governance.api_deprecations')).rows[0].n, 0, 'nada gravado');
  assert.equal(await auditCount(A, 'api.deprecation.announced'), before422);
});

test('m9d841 sunset anterior ao anúncio recusado', { skip: skip() }, async () => {
  const err = await env.failure(env.deprecate(A, env.asOwner(A, { target: 'MAJOR:1', announcedAt: '2026-10-27', sunsetAt: '2026-10-20' })));
  assert.deepEqual([err.status, err.code, err.message], [422, 'GOV_API_DEPRECATION_INVALID', 'A data de desligamento deve ser posterior ao anúncio.']);
  const igual = await env.failure(env.deprecate(A, env.asOwner(A, { target: 'MAJOR:1', announcedAt: '2026-10-27T12:00:00Z', sunsetAt: '2026-10-27T12:00:00Z' })));
  assert.equal(igual.code, 'GOV_API_DEPRECATION_INVALID', 'igual ao anúncio também recusa');
  assert.equal((await env.failure(env.deprecate(A, env.asOwner(A, { target: 'MAJOR:1', sunsetAt: 'em breve' })))).code, 'GOV_API_DATE_INVALID');
  const ok = await env.deprecate(A, env.asOwner(A, { target: 'ROUTE:get /people/:id', announcedAt: '2026-10-20', sunsetAt: '2027-02-01', replacement: '/v2/people/{id}', replacementNote: 'Use o recurso novo.' }));
  assert.equal(ok.target, 'ROUTE:GET /people/{id}');
  assert.equal(ok.status, 'ANNOUNCED');
  assert.equal(new Date(ok.sunsetAt).toISOString(), '2027-02-02T02:59:59.000Z', 'só data = fim do dia de Brasília');
  assert.equal((await env.auditOf(A, 'api.deprecation.announced')).length > 0, true, 'auditoria do anúncio');
  const dup = await env.failure(env.deprecate(A, env.asOwner(A, { target: 'ROUTE:GET /people/{id}', sunsetAt: '2027-03-01' })));
  assert.deepEqual([dup.status, dup.code], [409, 'GOV_API_DEPRECATION_EXISTS'], 'uma só em andamento por alvo');
  const replacement = await env.failure(env.deprecate(A, env.asOwner(A, { target: 'MAJOR:2', sunsetAt: '2027-03-01', replacement: 'https://x' })));
  assert.equal(replacement.code, 'GOV_API_REPLACEMENT_INVALID');
});

test('m9d841 consumidor externo nasce com a credencial de M9-D844', { skip: skip() }, async () => {
  const clientId = `qa-m9-client-${Date.now()}`;
  const consumer = await env.registerConsumer(A, { kind: 'PROVIDER', clientId, contactEmail: 'parceiro@exemplo.test' });
  assert.deepEqual([consumer.kind, consumer.status, consumer.apiVersionUsed, consumer.clientId, consumer.ownerUserId], ['PROVIDER', 'ACTIVE', 1, clientId, A.userId]);
  assert.equal((await env.auditOf(A, 'api.consumer.created')).some((row) => row.entity_id === consumer.id), true, 'cadastro auditado');
  const failures = [
    [{ ownerUserId: undefined }, 'ownerUserId'], [{ ownerUserId: B.userId }, 'ownerUserId'], [{ kind: 'INTERNAL' }, 'kind'], [{ kind: 'APP' }, 'kind'], [{ name: ' ' }, 'name'], [{ apiVersionUsed: 0 }, 'apiVersionUsed'], [{ contactEmail: 'sem-arroba' }, 'contactEmail'],
  ];
  for (const [over, field] of failures) {
    const err = await env.failure(env.registerConsumer(A, over));
    assert.equal(err.code, 'GOV_API_CONSUMER_INVALID', field);
    assert.ok(err.details.problems.some((p) => p.field === field), `problema em ${field}`);
  }
  const dupClient = await env.failure(env.registerConsumer(A, { clientId }));
  assert.deepEqual([dupClient.status, dupClient.code], [409, 'GOV_API_CONSUMER_EXISTS'], 'client_id é único');
  const dupName = await env.failure(env.registerConsumer(A, { name: consumer.name.toUpperCase() }));
  assert.equal(dupName.code, 'GOV_API_CONSUMER_EXISTS', 'nome único por empresa sem diferenciar maiúsculas');
  const row = (await env.adminQuery('SELECT owner_user_id FROM governance.api_consumers WHERE id = $1', [consumer.id])).rows[0];
  assert.ok(row.owner_user_id, 'todo consumidor tem responsável');
  const semDono = await env.adminQuery(`INSERT INTO governance.api_consumers (group_id, company_id, name, kind, owner_user_id) VALUES ($1, $2, 'QA-M9 sem dono', 'PARTNER', NULL)`, [A.groupId, A.companyId]).catch((err) => err);
  assert.equal(semDono.code, '23502', 'o banco também recusa consumidor sem responsável (NOT NULL)');
});

test('m9d841 isolamento entre empresas', { skip: skip() }, async () => {
  const mine = await env.registerConsumer(A);
  const dep = await env.deprecate(A, env.asOwner(A, { target: 'MAJOR:7', sunsetAt: env.isoIn(100) }));
  const listB = await env.inTx(B, (transaction) => env.consumersApi.listConsumers({ tenant: env.tenantOf(B), query: {}, transaction }));
  assert.equal(listB.items.some((item) => item.id === mine.id), false, 'B não vê o consumidor de A');
  const depsB = await env.inTx(B, (transaction) => env.consumersApi.listDeprecations({ tenant: env.tenantOf(B), query: {}, paging: { page: 1, pageSize: 50, limit: 50, offset: 0 }, transaction }));
  assert.equal(depsB.items.some((item) => item.id === dep.id), false, 'B não vê a deprecação de A');
  const cancelB = await env.failure(env.inTx(B, (transaction) => env.consumersApi.cancelDeprecation({ tenant: env.tenantOf(B), actorUserId: B.userId, id: dep.id, transaction })));
  assert.deepEqual([cancelB.status, cancelB.code], [404, 'GOV_NOT_FOUND'], 'B não cancela a deprecação de A');
  const cancelA = await env.inTx(A, (transaction) => env.consumersApi.cancelDeprecation({ tenant: env.tenantOf(A), actorUserId: A.userId, id: dep.id, transaction }));
  assert.equal(cancelA.status, 'CANCELLED');
  const again = await env.failure(env.inTx(A, (transaction) => env.consumersApi.cancelDeprecation({ tenant: env.tenantOf(A), actorUserId: A.userId, id: dep.id, transaction })));
  assert.deepEqual([again.status, again.code], [409, 'GOV_API_DEPRECATION_FINAL']);
  const rows = (await env.adminQuery("SELECT count(*)::int AS n FROM governance.api_consumers WHERE company_id = $1 AND id = $2", [B.companyId, mine.id])).rows[0].n;
  assert.equal(rows, 0);
});

test('m9d841 semente do front web por empresa', { skip: skip() }, async () => {
  const { Sequelize } = require('sequelize');
  const migration = require('../../../migrations/20260101000844-seed-governance-web-api-consumer');
  const admin = new Sequelize(process.env.DATABASE_ADMIN_URL, { logging: false });
  try {
    await env.adminQuery("DELETE FROM governance.api_consumers WHERE app_key = 'nayara-web'");
    await migration.up({ sequelize: admin });
    await migration.up({ sequelize: admin }); // idempotente
    for (const tenant of [A, B]) {
      const rows = (await env.adminQuery("SELECT * FROM governance.api_consumers WHERE company_id = $1 AND app_key = 'nayara-web'", [tenant.companyId])).rows;
      assert.equal(rows.length, 1, 'uma linha por empresa');
      const oldest = (await env.adminQuery("SELECT user_id FROM core.user_memberships WHERE company_id = $1 AND status = 'ACTIVE' AND deleted_at IS NULL ORDER BY created_at, id LIMIT 1", [tenant.companyId])).rows[0].user_id;
      assert.deepEqual([rows[0].kind, rows[0].status, rows[0].api_version_used, rows[0].owner_user_id], ['APP', 'ACTIVE', 1, oldest]);
    }
    const forced = (await env.adminQuery("SELECT relname, relforcerowsecurity FROM pg_class WHERE relname IN ('companies', 'user_memberships') AND relnamespace = 'core'::regnamespace ORDER BY 1")).rows;
    assert.ok(forced.every((row) => row.relforcerowsecurity), 'o FORCE RLS volta ao estado anterior depois da semente');
  } finally { await admin.close(); }
});
