'use strict';

/**
 * Corrida real (duas conexoes): duas reaberturas simultaneas do mesmo prazo CRITICAL (uma com B,
 * outra removendo o responsavel). A ordem de lock processo -> prazo serializa; uma so ganha, a
 * auditoria encadeia e nunca sobra CRITICAL PENDING sem responsavel efetivo.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { getSeedTenant, withTenantTransaction } = require('./testHelpers');
const { sequelize, newUser, concludedCriticalWithoutCaseResponsible: setup } = require('./legal.deadlineFinalState.helpers');
const legalDeadlinesService = require('../src/features/legal/legalDeadlines.service');
const { LegalDeadline, AuditLog } = require('../src/models');

let tenant;
before(async () => {
  tenant = await getSeedTenant();
});
after(async () => {
  await sequelize.close();
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function begin() {
  const tx = await sequelize.transaction();
  await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: tenant.groupId }, transaction: tx });
  await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: tenant.companyId }, transaction: tx });
  await sequelize.query('SET LOCAL app.user_id = :u', { replacements: { u: tenant.userId }, transaction: tx });
  return tx;
}

async function attempt(body, id, tx) {
  try {
    await legalDeadlinesService.updateLegalDeadline(id, body, tenant.userId, tx);
    return { ok: true };
  } catch (err) {
    await tx.rollback().catch(() => {});
    return { ok: false, status: err.statusCode, code: err.code };
  }
}

for (const order of ['B-primeiro', 'null-primeiro']) {
  test(`Duas reaberturas simultaneas (${order}): uma ganha, auditoria encadeada, estado final valido`, async () => {
    const fx = {};
    await withTenantTransaction(tenant, async (t) => {
      fx.b = await newUser(tenant, t);
      Object.assign(fx, await setup(tenant, t, {}));
    });
    const bodyB = { status: 'PENDING', responsibleUserId: fx.b.id };
    const bodyNull = { status: 'PENDING', responsibleUserId: null };
    const [firstBody, secondBody] = order === 'B-primeiro' ? [bodyB, bodyNull] : [bodyNull, bodyB];
    const t1 = await begin();
    const t2 = await begin();
    const first = await attempt(firstBody, fx.d.id, t1);
    const secondP = attempt(secondBody, fx.d.id, t2);
    await sleep(300);
    if (first.ok) await t1.commit();
    const second = await secondP;
    if (second.ok) await t2.commit();

    const results = order === 'B-primeiro' ? [first, second] : [second, first];
    const [rB, rNull] = results;
    assert.equal(rB.ok, true, `a reabertura com B deve ganhar: ${JSON.stringify(results)}`);
    assert.equal(rNull.ok, false);
    assert.equal(rNull.status, 422);
    assert.equal(rNull.code, 'LEGAL_DEADLINE_CRITICAL_RESPONSIBLE_REQUIRED');

    await withTenantTransaction(tenant, async (t) => {
      const final = await LegalDeadline.findByPk(fx.d.id, { transaction: t });
      assert.equal(final.status, 'PENDING');
      assert.equal(final.responsibleUserId, fx.b.id);
      const logs = await AuditLog.findAll({ where: { entityId: fx.d.id, action: 'legal.deadline.update' }, order: [['occurredAt', 'ASC']], transaction: t });
      assert.equal(logs.length, 2, 'conclusao + uma unica reabertura');
      assert.equal(logs[1].beforeJson.status, 'DONE');
      assert.equal(logs[1].beforeJson.responsibleUserId, logs[0].afterJson.responsibleUserId);
      assert.equal(logs[1].afterJson.responsibleUserId, fx.b.id);
    });
  });
}
