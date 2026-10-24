'use strict';

// Revisão independente do Marco 7 (19/10/2026) — seção B, Seguros (B5–B8).
// Banco real (Postgres, RLS ativo), tudo dentro de withRollbackTenantTransaction.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const insuranceService = require('../src/features/procurement/insurance.service');
const insuranceController = require('../src/features/procurement/insurance.controller');
const settingsService = require('../src/features/settings/settings.service');
const { FinancialEntry, InsuranceInstallment, InsuranceRenewalTask, InsuranceClaim } = require('../src/models');

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
const actor = () => withTenant({ userId: tenant.userId });

async function issuedPolicy(transaction, { installmentsCount = 3 } = {}) {
  const policy = await insuranceService.createPolicy(withTenant({}), tenant.userId, transaction);
  await insuranceService.quotePolicy(policy.id, { estimatedValue: 30000 }, actor(), transaction);
  return insuranceService.issuePolicy(policy.id, { effectiveDate: '2031-01-01', expiryDate: '2031-12-31', installmentsCount }, actor(), transaction);
}

async function submittedClaim(transaction, claimAmount = 1000) {
  const policy = await issuedPolicy(transaction, { installmentsCount: 1 });
  const claim = await insuranceService.openClaim(policy.id, { description: `REV19 sinistro ${uniqueSuffix()}`, claimAmount }, actor(), transaction, new Date('2031-03-01T12:00:00Z'));
  const submitted = await insuranceService.submitClaim(claim.id, actor(), transaction);
  return { policy, claim: submitted };
}

// ---------------------------------------------------------------------------------------------
// B5 — cancelar a apólice compensa o financeiro
// ---------------------------------------------------------------------------------------------
test('B5: cancelar a apólice cancela parcelas em aberto, estorna os payables do prêmio e encerra a tarefa de renovação', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const policy = await issuedPolicy(transaction);
    await insuranceService.cancelPolicy(policy.id, { reason: 'Imóvel vendido' }, actor(), transaction);

    const installments = await InsuranceInstallment.findAll({ where: { policyId: policy.id }, transaction });
    assert.equal(installments.length, 3);
    for (const inst of installments) {
      assert.equal(inst.status, 'CANCELED', 'parcela em aberto de apólice cancelada não pode continuar a vencer');
       
      const entry = await FinancialEntry.findByPk(inst.financialEntryId, { transaction });
      assert.ok(['REVERSED', 'CANCELLED'].includes(entry.status), `payable do prêmio precisa sair do contas a pagar (status ${entry.status})`);
    }
    const tasks = await InsuranceRenewalTask.findAll({ where: { policyId: policy.id }, transaction });
    assert.ok(tasks.length > 0);
    assert.ok(tasks.every((t) => t.status === 'DISMISSED'), 'tarefa de renovação de apólice cancelada é encerrada');
  });
});

// ---------------------------------------------------------------------------------------------
// B6 — webhook sem HMAC no sandbox, sandbox em produção e valor sem limite
// ---------------------------------------------------------------------------------------------
test('B6: webhook em sandbox sem HMAC é recusado (401) e nada é liquidado', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { claim } = await submittedClaim(transaction);
    const body = { externalSubmissionId: claim.externalClaimId, status: 'SETTLED', settledAmount: 999999 };
    await assert.rejects(
      () => insuranceController.processInsuranceWebhook(body, Buffer.from(JSON.stringify(body)), {}, transaction),
      (err) => err.code === 'INSURANCE_WEBHOOK_HMAC_INVALID' && err.statusCode === 401
    );
    const after = await InsuranceClaim.findByPk(claim.id, { transaction });
    assert.equal(after.status, 'SUBMITTED');
  });
});

test('B6: webhook em sandbox com HMAC válido liquida, mas nunca acima do valor do sinistro', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const secret = `rev19-${uniqueSuffix()}`;
    await settingsService.upsertSetting('procurement.insurance_webhook_secret', secret, tenant, tenant.userId, transaction);
    const { claim } = await submittedClaim(transaction, 1000);
    const body = { externalSubmissionId: claim.externalClaimId, status: 'SETTLED', settledAmount: 999999 };
    const raw = Buffer.from(JSON.stringify(body));
    const sig = crypto.createHmac('sha256', secret).update(raw).digest('hex');
    await insuranceController.processInsuranceWebhook(body, raw, { 'x-webhook-signature': `sha256=${sig}` }, transaction);

    const after = await InsuranceClaim.findByPk(claim.id, { transaction });
    assert.equal(after.status, 'SETTLED');
    assert.equal(Number(after.settledAmount), 1000, 'indenização limitada ao valor do sinistro');
    const entry = await FinancialEntry.findByPk(after.financialEntryId, { transaction });
    assert.equal(Number(entry.amount), 1000);
  });
});

test('B6: com DEPLOY_ENVIRONMENT=production o sandbox é recusado (webhook e emissão)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const secret = `rev19-${uniqueSuffix()}`;
    await settingsService.upsertSetting('procurement.insurance_webhook_secret', secret, tenant, tenant.userId, transaction);
    const { claim } = await submittedClaim(transaction);
    const previous = process.env.DEPLOY_ENVIRONMENT;
    process.env.DEPLOY_ENVIRONMENT = 'production';
    try {
      const body = { externalSubmissionId: claim.externalClaimId, status: 'SETTLED', settledAmount: 10 };
      const raw = Buffer.from(JSON.stringify(body));
      const sig = crypto.createHmac('sha256', secret).update(raw).digest('hex');
      await assert.rejects(
        () => insuranceController.processInsuranceWebhook(body, raw, { 'x-webhook-signature': sig }, transaction),
        (err) => err.code === 'INSURANCE_SANDBOX_FORBIDDEN_IN_PRODUCTION'
      );
      const policy = await insuranceService.createPolicy(withTenant({}), tenant.userId, transaction);
      await assert.rejects(
        () => insuranceService.quotePolicy(policy.id, { estimatedValue: 100 }, actor(), transaction),
        (err) => err.code === 'INSURANCE_SANDBOX_FORBIDDEN_IN_PRODUCTION'
      );
    } finally {
      if (previous === undefined) delete process.env.DEPLOY_ENVIRONMENT;
      else process.env.DEPLOY_ENVIRONMENT = previous;
    }
  });
});

// ---------------------------------------------------------------------------------------------
// B7 — fallback do sandbox grava o nome do provedor real
// ---------------------------------------------------------------------------------------------
test('B7: provedor real sem credencial não cai em silêncio no sandbox gravando o nome do provedor real', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    await settingsService.upsertSetting('procurement.insurance_provider', 'porto_seguro', tenant, tenant.userId, transaction);
    const policy = await insuranceService.createPolicy(withTenant({}), tenant.userId, transaction);
    await assert.rejects(
      () => insuranceService.quotePolicy(policy.id, { estimatedValue: 100 }, actor(), transaction),
      (err) => err.code === 'PROCUREMENT_INSURANCE_PROVIDER_CONFIG_MISSING'
    );
  });
});

test('B7: apólice emitida pelo sandbox fica gravada como "sandbox"', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const policy = await issuedPolicy(transaction, { installmentsCount: 1 });
    assert.equal(policy.provider, 'sandbox');
  });
});

// ---------------------------------------------------------------------------------------------
// B8 — vigência obrigatória na emissão
// ---------------------------------------------------------------------------------------------
test('B8: emitir sem vigência (início e fim) é recusado', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const policy = await insuranceService.createPolicy(withTenant({}), tenant.userId, transaction);
    await insuranceService.quotePolicy(policy.id, { estimatedValue: 10000 }, actor(), transaction);
    await assert.rejects(
      () => insuranceService.issuePolicy(policy.id, { installmentsCount: 1 }, actor(), transaction),
      (err) => err.code === 'INSURANCE_POLICY_VALIDATION' && /vigência/i.test(err.message)
    );
    await assert.rejects(
      () => insuranceService.issuePolicy(policy.id, { effectiveDate: '2031-01-01', installmentsCount: 1 }, actor(), transaction),
      (err) => err.code === 'INSURANCE_POLICY_VALIDATION'
    );
  });
});
