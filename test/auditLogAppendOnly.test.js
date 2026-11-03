'use strict';

// audit.audit_log é append-only no banco (migration 20260101000490): INSERT permitido,
// UPDATE/DELETE recusados para a role de runtime. Tudo dentro de transação com rollback.
const test = require('node:test');
const assert = require('node:assert/strict');
const { sequelize, getSeedTenant, withRollbackTenantTransaction } = require('./testHelpers');

let tenant;
test.before(async () => { tenant = await getSeedTenant(); });
test.after(async () => { await sequelize.close(); });

async function insertRow(t) {
  const [[row]] = await sequelize.query(
    `INSERT INTO audit.audit_log (id, group_id, company_id, user_id, action, entity_type, occurred_at, created_at, updated_at)
     VALUES (gen_random_uuid(), :g, :c, :u, 'test.append_only', 'AuditLogAppendOnlyTest', now(), now(), now())
     RETURNING id`,
    { replacements: { g: tenant.groupId, c: tenant.companyId, u: tenant.userId }, transaction: t }
  );
  return row.id;
}

async function expectRefused(t, sql, id) {
  await sequelize.query('SAVEPOINT sp', { transaction: t });
  await assert.rejects(
    sequelize.query(sql, { replacements: { id }, transaction: t }),
    (err) => ['42501'].includes(err?.parent?.code || err?.original?.code)
  );
  await sequelize.query('ROLLBACK TO SAVEPOINT sp', { transaction: t });
}

test('INSERT em audit.audit_log é permitido', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const id = await insertRow(t);
    assert.ok(id);
  });
});

test('UPDATE em audit.audit_log é recusado para o runtime', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const id = await insertRow(t);
    await expectRefused(t, `UPDATE audit.audit_log SET reason = 'adulterado' WHERE id = :id`, id);
    const [[row]] = await sequelize.query('SELECT reason FROM audit.audit_log WHERE id = :id', { replacements: { id }, transaction: t });
    assert.equal(row.reason, null);
  });
});

test('DELETE em audit.audit_log é recusado para o runtime', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const id = await insertRow(t);
    await expectRefused(t, 'DELETE FROM audit.audit_log WHERE id = :id', id);
    const [[{ n }]] = await sequelize.query('SELECT count(*)::int AS n FROM audit.audit_log WHERE id = :id', { replacements: { id }, transaction: t });
    assert.equal(n, 1);
  });
});
