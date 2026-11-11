'use strict';

/**
 * Corrida real (duas conexoes): duas reaberturas simultaneas do mesmo prazo CRITICAL (uma com B,
 * outra removendo o responsavel). A ordem de lock processo -> prazo serializa; uma so ganha, a
 * auditoria encadeia e nunca sobra CRITICAL PENDING sem responsavel efetivo.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { getSeedTenant, withTenantTransaction } = require('./testHelpers');
const { prepararOrigem } = require('./helpers/prazoOrigem');
const { sequelize, newUser, concludedCriticalWithoutCaseResponsible: setup } = require('./legal.deadlineFinalState.helpers');
const legalDeadlinesService = require('../src/features/legal/legalDeadlines.service');
const { LegalDeadline, AuditLog } = require('../src/models');
const { createRaceLog } = require('./legal.raceSessionLog.helpers');

let tenant;
before(async () => {
  tenant = await getSeedTenant();
  await prepararOrigem(tenant);
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
    const log = createRaceLog(sequelize, `Duas reaberturas simultaneas (${order})`);
    const label = (body) => (body.responsibleUserId ? 'B (reabre com responsavel B)' : 'null (reabre removendo o responsavel)');
    log.emit(`prazo CRITICAL ${fx.d.id} (DONE) do processo ${fx.legalCase.id}; processo sem responsavel proprio; usuario B = ${fx.b.id}`);
    const t1 = await begin();
    const t2 = await begin();
    const s1 = await log.session(`1 = ${label(firstBody)}`, t1);
    const s2 = await log.session(`2 = ${label(secondBody)}`, t2);
    const byPid = { [s1.pid]: s1, [s2.pid]: s2 };
    const first = await attempt(firstBody, fx.d.id, t1);
    log.emit(`sessão 1 executou PATCH ${JSON.stringify(firstBody)} -> ${log.outcome(first)}; ${first.ok ? 'transação 1 segue ABERTA (segurando o lock processo -> prazo)' : 'transação 1 encerrada por ROLLBACK (nada gravado)'}`);
    const secondP = attempt(secondBody, fx.d.id, t2);
    log.emit(`sessão 2 disparou PATCH ${JSON.stringify(secondBody)} ${first.ok ? 'enquanto a transação 1 está aberta' : 'com a transação 1 já encerrada'}`);
    await sleep(300);
    await log.observe(s2, byPid);
    if (first.ok) await t1.commit();
    log.emit(first.ok ? 'sessão 1 COMMIT (1º commit)' : 'sessão 1 já tinha feito ROLLBACK (recusada)');
    const second = await secondP;
    log.emit(`sessão 2 terminou${first.ok ? ' depois do commit da 1' : ''} -> ${log.outcome(second)}`);
    if (second.ok) await t2.commit();
    log.emit(second.ok ? `sessão 2 COMMIT (${first.ok ? '2º' : 'único'} commit)` : 'sessão 2 ROLLBACK (recusada, nada gravado)');

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
      log.emit(`estado final: status=${final.status} criticality=${final.criticality} responsavel=${final.responsibleUserId}; audit_log legal.deadline.update = ${logs.length} linhas (conclusao + 1 reabertura); before.status da reabertura = ${logs[1].beforeJson.status}`);
    });
  });
}
