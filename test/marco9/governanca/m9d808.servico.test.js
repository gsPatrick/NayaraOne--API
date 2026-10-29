'use strict';

// M9-D808 — alteração em massa (serviço): auditoria por registro, hash nos itens, teto, filtro, evidência, atomicidade, idempotência e isolamento.
// Banco descartável:
//   node scripts/withDisposableDb.js --port <55000-56999> -- env CI_TENANT_USERS_PASSWORD=... bash -c \
//     "node scripts/seed-ci-two-tenants.js >/dev/null && NODE_ENV=test node --test --test-concurrency=1 test/marco9/governanca/m9d808.servico.test.js"

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d808Env');
const bulk = require('../../../src/features/core-governance/data-quality/bulk.service');
const { upsertSetting } = require('../../../src/features/settings/settings.service');
const { withTenantTransaction } = require('../../testHelpers');
const { adminQuery } = require('../../m9d801.helpers');

let tenants;
const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
before(async () => { if (env.DISPOSABLE) tenants = await env.loadTenants(); });
after(async () => { await env.sequelize.close(); });
const A = () => tenants.A;
const actor = () => ({ userId: A().userId, roles: ['ADMIN'] });
const run = (fn) => env.withRollbackTenantTransaction(A(), fn);
const execute = (tx, body, key = env.key(), tenant = A()) => bulk.executeBulk(tenant, { userId: tenant.userId, roles: [] }, body, { idempotencyKey: key }, tx);
const codeOf = (promise) => promise.then(() => null, (err) => [err.statusCode, err.code]);

test('m9d808 cada registro alterado tem auditoria com bulk_change_id (lote de 80 imóveis, campo não crítico)', { skip: skip() }, async () => {
  await run(async (tx) => {
    const { city, rows } = await env.properties(A(), tx, 80);
    const result = await execute(tx, env.bulkBody(city, { city: 'Cidade Corrigida QA' }));
    assert.deepEqual([result.lot.status, result.lot.affectedCount, result.replayed], ['DONE', 80, false]);
    assert.equal(await env.cityOf(rows[0].id, tx), 'Cidade Corrigida QA');
    const audits = await env.auditRows(A(), 'governance.bulk_change.item', tx, "after_json->>'bulk_change_id' = :lot", { lot: result.lot.id });
    assert.equal(audits.length, 80, 'uma auditoria por registro alterado');
    assert.ok(audits.every((a) => a.entity_type === 'Property' && a.before_json.city === city && a.after_json.city === 'Cidade Corrigida QA' && a.user_id === A().userId));
    assert.deepEqual(new Set(audits.map((a) => a.entity_id)), new Set(rows.map((r) => r.id)));
    const items = await env.itemRows(result.lot.id, tx);
    assert.equal(items.length, 80);
    assert.ok(items.every((i) => i.audit_log_id && audits.some((a) => a.id === i.audit_log_id)));
    const lotAudit = await env.auditRows(A(), 'governance.bulk_change.executed', tx, 'entity_id = :lot', { lot: result.lot.id });
    assert.equal(lotAudit.length, 1);
  });
});

test('m9d808 itens do lote guardam hash e não o valor em claro', { skip: skip() }, async () => {
  await run(async (tx) => {
    const { city } = await env.properties(A(), tx, 2);
    const novo = `Nome Novo ${env.tag()}`;
    const result = await execute(tx, env.bulkBody(city, { city: novo }));
    const items = await env.itemRows(result.lot.id, tx);
    for (const item of items) {
      assert.deepEqual(Object.keys(item.field_hashes), ['city']);
      assert.match(item.field_hashes.city.before, /^[0-9a-f]{64}$/);
      assert.match(item.field_hashes.city.after, /^[0-9a-f]{64}$/);
      const text = JSON.stringify(item);
      assert.ok(!text.includes(novo) && !text.includes(city), 'nenhum valor em claro no item');
    }
    const [lot] = await env.lotRows(A(), tx, 'id = :id', { id: result.lot.id });
    assert.equal(lot.affected_count, 2);
    assert.equal(lot.reason, 'QA-M9 correção em massa do nome da cidade');
  });
});

test('m9d808 filtro com campo desconhecido ou SQL é recusado (400 GOV_BULK_FILTER_INVALID) e nada é gravado', { skip: skip() }, async () => {
  await run(async (tx) => {
    const { city, rows } = await env.properties(A(), tx, 2);
    const bad = [
      { 'city; DROP TABLE real_estate.properties': city }, { campoInexistente: 'x' }, "city = 'x' OR 1=1", [city], { city: { $ne: city } }, { city: { isNull: 'talvez' } },
      { city: { '1=1': true } }, { ids: 'não é lista' }, { ids: ['nao-e-uuid'] }, { city: [['aninhado']] }, {},
    ];
    for (const filter of bad) assert.deepEqual(await codeOf(execute(tx, env.bulkBody(city, { city: 'X' }, { filter }))), [400, 'GOV_BULK_FILTER_INVALID'], JSON.stringify(filter));
    assert.equal(await env.cityOf(rows[0].id, tx), city);
    assert.deepEqual(await env.lotRows(A(), tx, "filter_json->>'city' = :city", { city }), []);
  });
});

test('m9d808 corpo inválido: tipo, motivo, alteração e campo fora da lista devolvem 400', { skip: skip() }, async () => {
  await run(async (tx) => {
    const { city } = await env.properties(A(), tx, 1);
    const cases = [
      [env.bulkBody(city, { city: 'X' }, { entity_type: 'CONTRATO' }), 'VALIDATION_ERROR'],
      [env.bulkBody(city, { city: 'X' }, { reason: '   ' }), 'VALIDATION_ERROR'],
      [env.bulkBody(city, { city: 'X' }, { reason: 'curto' }), 'VALIDATION_ERROR'],
      [env.bulkBody(city, {}), 'VALIDATION_ERROR'],
      [env.bulkBody(city, { internalCode: 'X' }), 'VALIDATION_ERROR'],
      [env.bulkBody(city, { availabilityStatus: 'VENDIDO' }), 'VALIDATION_ERROR'],
    ];
    for (const [body, code] of cases) assert.deepEqual(await codeOf(execute(tx, body)), [400, code], JSON.stringify(body));
  });
});

test('m9d808 lote acima do limite devolve 422 GOV_BULK_TOO_LARGE e a tentativa bloqueada é auditada', { skip: skip() }, async () => {
  const { city, rows } = await withTenantTransaction(A(), async (tx) => {
    const created = await env.properties(A(), tx, 3);
    await upsertSetting('governanca.dados.bulk.max_registros', 2, A(), A().userId, tx);
    return created;
  });
  try {
    const key = env.key();
    const failure = await codeOf(withTenantTransaction(A(), (tx) => execute(tx, env.bulkBody(city, { city: 'Nunca Grava' }), key)));
    assert.deepEqual(failure, [422, 'GOV_BULK_TOO_LARGE']);
    assert.equal(await env.cityOf(rows[0].id), city);
    const blocked = (await adminQuery("SELECT after_json FROM audit.audit_log WHERE company_id = $1 AND action = 'governance.bulk_change.blocked' AND after_json->>'code' = 'GOV_BULK_TOO_LARGE' ORDER BY occurred_at DESC LIMIT 1", [A().companyId])).rows;
    assert.equal(blocked.length, 1, 'tentativa bloqueada auditada');
    assert.deepEqual([blocked[0].after_json.matched, blocked[0].after_json.limit, blocked[0].after_json.entityType], [3, 2, 'PROPERTY']);
  } finally {
    await withTenantTransaction(A(), (tx) => upsertSetting('governanca.dados.bulk.max_registros', 5000, A(), A().userId, tx));
  }
});

test('m9d808 isolamento entre empresas: o lote só alcança a empresa do autor', { skip: skip() }, async () => {
  const city = `Cidade Compartilhada ${env.tag()}`;
  const mine = await withTenantTransaction(A(), (tx) => env.properties(A(), tx, 2, { city }));
  const theirs = await withTenantTransaction(tenants.B, (tx) => env.properties(tenants.B, tx, 2, { city }));
  const result = await withTenantTransaction(A(), (tx) => execute(tx, env.bulkBody(city, { city: 'So Da Empresa A' })));
  assert.equal(result.lot.affectedCount, 2);
  assert.equal(await env.cityOf(mine.rows[0].id), 'So Da Empresa A');
  assert.equal(await env.cityOf(theirs.rows[0].id), city, 'imóvel da outra empresa intocado');
  assert.deepEqual(await codeOf(withTenantTransaction(tenants.B, (tx) => bulk.getBulkChange(tenants.B, result.lot.id, {}, tx))), [404, 'GOV_NOT_FOUND']);
  const own = await withTenantTransaction(A(), (tx) => bulk.getBulkChange(A(), result.lot.id, {}, tx));
  assert.deepEqual([own.lot.status, own.items.length, own.itemsTotal], ['DONE', 2, 2]);
  const seenByB = await withTenantTransaction(tenants.B, (tx) => bulk.listBulkChanges(tenants.B, {}, tx));
  assert.ok(!seenByB.items.some((l) => l.id === result.lot.id));
});

test('m9d808 Idempotency-Key: mesma chave e mesmo corpo devolve o lote original; outro corpo é 422', { skip: skip() }, async () => {
  const { city, rows } = await withTenantTransaction(A(), (tx) => env.properties(A(), tx, 2));
  const key = env.key();
  const first = await withTenantTransaction(A(), (tx) => execute(tx, env.bulkBody(city, { city: 'Primeira Vez QA' }), key));
  const again = await withTenantTransaction(A(), (tx) => execute(tx, env.bulkBody(city, { city: 'Primeira Vez QA' }), key));
  assert.deepEqual([again.replayed, again.lot.id], [true, first.lot.id]);
  assert.deepEqual(await codeOf(withTenantTransaction(A(), (tx) => execute(tx, env.bulkBody(city, { city: 'Outra Coisa QA' }), key))), [422, 'GOV_IDEMPOTENCY_KEY_REUSED']);
  const lots = (await adminQuery('SELECT id FROM governance.bulk_changes WHERE company_id = $1 AND idempotency_key = $2', [A().companyId, key])).rows;
  assert.equal(lots.length, 1, 'um lote só');
  assert.equal(await env.cityOf(rows[0].id), 'Primeira Vez QA');
  const noKey = await codeOf(withTenantTransaction(A(), (tx) => bulk.executeBulk(A(), actor(), env.bulkBody(city, { city: 'Z' }), {}, tx)));
  assert.deepEqual(noKey, [400, 'GOV_IDEMPOTENCY_KEY_REQUIRED']);
  const shortKey = await codeOf(withTenantTransaction(A(), (tx) => bulk.executeBulk(A(), actor(), env.bulkBody(city, { city: 'Z' }), { idempotencyKey: 'curta' }, tx)));
  assert.deepEqual(shortKey, [400, 'GOV_IDEMPOTENCY_KEY_REQUIRED']);
});

test('m9d808 itens do lote são imutáveis (o histórico do que mudou não se reescreve)', { skip: skip() }, async () => {
  const { city } = await withTenantTransaction(A(), (tx) => env.properties(A(), tx, 1));
  const result = await withTenantTransaction(A(), (tx) => execute(tx, env.bulkBody(city, { city: 'Imutavel QA' })));
  await assert.rejects(() => adminQuery('UPDATE governance.bulk_change_items SET record_type = $1 WHERE bulk_change_id = $2', ['PERSON', result.lot.id]), /imutável/);
  await assert.rejects(() => adminQuery('DELETE FROM governance.bulk_change_items WHERE bulk_change_id = $1', [result.lot.id]), /imutável/);
});
