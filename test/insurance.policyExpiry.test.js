'use strict';

// GAP REAL CORRIGIDO (auditoria contrato Marco 7, 2026-10-07 — "Apólice com ... vigência ...
// renovação alerta"): só existia o alerta de renovação; nada aplicava a vigência quando ela
// acabava. Uma apólice ACTIVE com expiryDate no passado ainda aceitava sinistro novo, porque
// `openClaim` só olhava `policy.status`. Este arquivo prova:
//   1. sinistro NOVO em apólice vencida é bloqueado (INSURANCE_POLICY_EXPIRED) pela DATA, mesmo
//      com o status gravado ainda ACTIVE (job ainda não rodou);
//   2. o último dia de vigência (expiryDate) ainda é coberto, no fuso America/Sao_Paulo;
//   3. sinistro aberto ANTES do vencimento continua o fluxo (submit + liquidação) depois;
//   4. `expireDuePolicies` transiciona ACTIVE/ISSUED vencidas para EXPIRED, notifica, não toca
//      apólice vigente nem rascunho, e é idempotente.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction } = require('./testHelpers');
const { InsurancePolicy, Notification } = require('../src/models');
const insuranceService = require('../src/features/procurement/insurance.service');
const { expireDuePolicies } = require('../src/engines/jobs/insurancePolicyExpiryJob');
const AppError = require('../src/utils/AppError');

let tenant;

before(async () => {
  tenant = await getSeedTenant();
});

after(async () => {
  await sequelize.close();
});

function withTenant(fields) {
  return { groupId: tenant.groupId, companyId: tenant.companyId, ...fields };
}

function addDays(dateOnly, days) {
  const [y, m, d] = dateOnly.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

async function issuedPolicy(transaction, effectiveDate, expiryDate) {
  const policy = await insuranceService.createPolicy(withTenant({}), tenant.userId, transaction);
  const issued = await insuranceService.issuePolicy(policy.id, { effectiveDate, expiryDate }, withTenant({ userId: tenant.userId }), transaction);
  assert.equal(issued.status, 'ACTIVE');
  return issued;
}

function assertExpiredError(err) {
  assert.ok(err instanceof AppError);
  assert.equal(err.code, 'INSURANCE_POLICY_EXPIRED');
  assert.equal(err.statusCode, 409);
  return true;
}

test('Vigência: apólice ACTIVE com expiryDate no passado (backdate direto no banco) NÃO aceita sinistro novo', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const today = insuranceService.todayDateOnly();
    const policy = await issuedPolicy(transaction, addDays(today, -30), addDays(today, 335));

    // Backdate direto — simula a vigência acabando sem o job ter rodado ainda (status segue ACTIVE).
    await InsurancePolicy.update({ expiryDate: addDays(today, -1) }, { where: { id: policy.id }, transaction });
    const reloaded = await InsurancePolicy.findByPk(policy.id, { transaction });
    assert.equal(reloaded.status, 'ACTIVE', 'pré-condição: status gravado ainda ACTIVE');

    await assert.rejects(
      () => insuranceService.openClaim(policy.id, { description: 'sinistro pós-vigência', claimAmount: 100 }, withTenant({ userId: tenant.userId }), transaction),
      assertExpiredError
    );

    // Leitura expõe o derivado pro front, mesmo antes do job.
    const fetched = await insuranceService.getPolicy(policy.id, tenant.groupId, tenant.companyId, transaction);
    assert.equal(fetched.toJSON().isExpired, true);
  });
});

test('Vigência: emitida já com vigência passada também bloqueia; último dia de vigência (fuso São Paulo) ainda é coberto', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const policy = await issuedPolicy(transaction, '2026-01-01', '2026-06-30');

    // 30/06 23:30 em São Paulo = 01/07 02:30 UTC — ainda é o último dia de cobertura no Brasil.
    const lastMinuteOfCoverage = new Date('2026-07-01T02:30:00Z');
    const claim = await insuranceService.openClaim(
      policy.id, { description: 'último dia', claimAmount: 50 }, withTenant({ userId: tenant.userId }), transaction, lastMinuteOfCoverage
    );
    assert.equal(claim.status, 'OPEN');

    // 01/07 00:30 em São Paulo — vigência encerrada.
    const afterCoverage = new Date('2026-07-01T03:30:00Z');
    await assert.rejects(
      () => insuranceService.openClaim(policy.id, { description: 'dia seguinte', claimAmount: 50 }, withTenant({ userId: tenant.userId }), transaction, afterCoverage),
      assertExpiredError
    );

    // Sem `now` explícito (relógio real, hoje > 2026-06-30) também bloqueia.
    await assert.rejects(
      () => insuranceService.openClaim(policy.id, { description: 'hoje' }, withTenant({ userId: tenant.userId }), transaction),
      assertExpiredError
    );
  });
});

test('Vigência: job expira a apólice, sinistro aberto ANTES do vencimento segue até liquidação, sinistro novo é bloqueado', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const policy = await issuedPolicy(transaction, '2026-01-01', '2026-06-30');
    const duringCoverage = new Date('2026-06-15T15:00:00Z');
    const afterCoverage = new Date('2026-07-02T15:00:00Z');

    const claim = await insuranceService.openClaim(
      policy.id, { description: 'aberto durante a vigência', claimAmount: 1200 }, withTenant({ userId: tenant.userId }), transaction, duringCoverage
    );

    const result = await expireDuePolicies(transaction, afterCoverage);
    assert.ok(result.expired >= 1);
    const expired = await insuranceService.getPolicy(policy.id, tenant.groupId, tenant.companyId, transaction);
    assert.equal(expired.status, 'EXPIRED');
    assert.equal(expired.toJSON().isExpired, true);

    // Sinistro em andamento NÃO é quebrado retroativamente.
    const submitted = await insuranceService.submitClaim(claim.id, withTenant({ userId: tenant.userId }), transaction);
    assert.equal(submitted.status, 'SUBMITTED');
    const settled = await insuranceService.confirmClaimSettlement(submitted.externalClaimId, 'SETTLED', 1200, transaction);
    assert.equal(settled.status, 'SETTLED');
    assert.ok(settled.financialEntryId, 'indenização de sinistro aberto em vigência continua integrando o Financeiro');

    // Sinistro novo: bloqueado mesmo se o chamador "mentir" a data pra dentro da vigência — o
    // status EXPIRED gravado é terminal.
    await assert.rejects(
      () => insuranceService.openClaim(policy.id, { description: 'novo' }, withTenant({ userId: tenant.userId }), transaction, duringCoverage),
      assertExpiredError
    );

    // Filtro por status no list continua funcionando com o status novo.
    const listed = await insuranceService.listPolicies({ status: 'EXPIRED' }, tenant.groupId, tenant.companyId, transaction);
    assert.ok(listed.some((p) => p.id === policy.id));
  });
});

test('Vigência: expireDuePolicies só toca ACTIVE/ISSUED vencidas, notifica, e é idempotente', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const now = new Date('2026-07-02T15:00:00Z');
    const due = await issuedPolicy(transaction, '2026-01-01', '2026-06-30');
    const lastDayToday = await issuedPolicy(transaction, '2026-01-01', '2026-07-02');
    const future = await issuedPolicy(transaction, '2026-01-01', '2027-01-01');
    const draft = await insuranceService.createPolicy(withTenant({}), tenant.userId, transaction);
    await InsurancePolicy.update({ expiryDate: '2026-01-31' }, { where: { id: draft.id }, transaction });

    const first = await expireDuePolicies(transaction, now);
    assert.ok(first.expired >= 1, 'a apólice vencida precisa ser expirada na primeira execução');

    const statusOf = async (id) => (await InsurancePolicy.findByPk(id, { transaction })).status;
    assert.equal(await statusOf(due.id), 'EXPIRED');
    assert.equal(await statusOf(lastDayToday.id), 'ACTIVE', 'expiryDate == hoje ainda é vigência (inclusive)');
    assert.equal(await statusOf(future.id), 'ACTIVE');
    assert.equal(await statusOf(draft.id), 'DRAFT', 'rascunho nunca vira EXPIRED');

    const notifications = await Notification.findAll({
      where: { userId: tenant.userId, title: 'Apólice de seguro vencida' },
      transaction,
    });
    const forDue = notifications.filter((n) => n.body.includes(due.externalPolicyNumber || due.id));
    assert.equal(forDue.length, 1, 'uma Notification real por apólice expirada');

    const second = await expireDuePolicies(transaction, now);
    assert.equal(second.expired, 0, 'segunda execução não pode re-expirar nem re-notificar');
    const notificationsAfter = await Notification.findAll({
      where: { userId: tenant.userId, title: 'Apólice de seguro vencida' },
      transaction,
    });
    assert.equal(notificationsAfter.length, notifications.length);
  });
});
