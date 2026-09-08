'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { authenticator } = require('otplib');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const settingsService = require('../src/features/settings/settings.service');
const contractsService = require('../src/features/legal/contracts.service');
const billingScheduleService = require('../src/features/billing/billingSchedule.service');
const collectionCaseService = require('../src/features/billing/collectionCase.service');
const mfaService = require('../src/features/users/mfa.service');
const { User } = require('../src/models');
const AppError = require('../src/utils/AppError');

let tenant;

before(async () => {
  tenant = await getSeedTenant();
});

after(async () => {
  await sequelize.close();
});

async function createLeaseContract(transaction, overrides = {}) {
  const contract = await contractsService.createContract(
    { groupId: tenant.groupId, companyId: tenant.companyId, contractType: 'LEASE', totalValue: 2000, ...overrides },
    tenant.userId,
    transaction
  );
  contract.status = 'ACTIVE';
  await contract.save({ transaction });
  return contract;
}

async function createSecondUser(suffix) {
  const [user] = await User.findOrCreate({
    where: { email: `homo-qa-settings-${suffix}@nayaraone.dev` },
    defaults: { name: `HOMO QA — Settings ${suffix}`, passwordHash: 'x', status: 'ACTIVE' },
  });
  return user.id;
}

function extractSecret(otpauthUri) {
  const match = /[?&]secret=([^&]+)/.exec(otpauthUri);
  if (!match) throw new Error('otpauth:// sem secret na URI');
  return match[1];
}

// --- upsert persiste e getSetting lê de volta ---
test('settings: upsert persiste e getSetting lê o valor configurado de volta', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const row = await settingsService.upsertSetting('billing.late_fee_percentage', 4.5, tenant, tenant.userId, transaction);
    assert.equal(Number(row.value), 4.5);

    const readBack = await settingsService.getSetting('billing.late_fee_percentage', tenant, transaction, 2);
    assert.equal(Number(readBack), 4.5);

    // Upsert sobre a mesma chave atualiza em vez de duplicar.
    const updated = await settingsService.upsertSetting('billing.late_fee_percentage', 6, tenant, tenant.userId, transaction);
    assert.equal(updated.id, row.id);
    const readAfterUpdate = await settingsService.getSetting('billing.late_fee_percentage', tenant, transaction, 2);
    assert.equal(Number(readAfterUpdate), 6);
  });
});

// --- valores fora do schema são rejeitados (fail closed) ---
test('settings: valores fora do schema (ou chave desconhecida) são rejeitados com 400', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    await assert.rejects(
      () => settingsService.upsertSetting('billing.late_fee_percentage', -1, tenant, tenant.userId, transaction),
      (err) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.statusCode, 400);
        assert.equal(err.code, 'SETTING_INVALID_VALUE');
        return true;
      }
    );

    await assert.rejects(
      () => settingsService.upsertSetting('billing.late_fee_percentage', 101, tenant, tenant.userId, transaction),
      (err) => {
        assert.equal(err.code, 'SETTING_INVALID_VALUE');
        return true;
      }
    );

    await assert.rejects(
      () => settingsService.upsertSetting('billing.late_fee_percentage', 'dez por cento', tenant, tenant.userId, transaction),
      (err) => {
        assert.equal(err.code, 'SETTING_INVALID_VALUE');
        return true;
      }
    );

    await assert.rejects(
      () => settingsService.upsertSetting('billing.chave_inexistente', 1, tenant, tenant.userId, transaction),
      (err) => {
        assert.equal(err.code, 'SETTING_UNKNOWN_KEY');
        return true;
      }
    );
  });
});

// --- chave sem configuração retorna default sem erro ---
test('settings: chave sem configuração para o tenant retorna o default informado, sem lançar erro', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const value = await settingsService.getSetting('mfa.step_up_ttl_minutes', tenant, transaction, 10);
    assert.equal(value, 10);

    // Sem tenant/transaction utilizável também retorna default, nunca lança.
    const valueNoTenant = await settingsService.getSetting('mfa.step_up_ttl_minutes', null, transaction, 42);
    assert.equal(valueNoTenant, 42);
  });
});

// --- alterar multa configurada muda o valor calculado na próxima cobrança em atraso ---
test('settings: alterar billing.late_fee_percentage muda a multa calculada por collectionCase.service', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const contract = await createLeaseContract(transaction);
    const schedule = await billingScheduleService.generateBillingSchedule(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        contractId: contract.id,
        period: '2027-01',
        dueDate: '2027-01-05',
        items: [{ componentType: 'RENT', amount: 1000 }],
      },
      tenant.userId,
      transaction
    );

    // Sem configuração de tenant: usa o default do actionJson da regra publicada (2%).
    const daysPastDue = 10; // > carência de 3 dias
    const caseDefault = await collectionCaseService.openCollectionCase(schedule.id, daysPastDue, tenant.userId, transaction);
    assert.equal(Number(caseDefault.penaltyAmount), 20); // 1000 * 2%

    // Configura multa de 10% para o tenant e abre um novo caso (nova competência).
    await settingsService.upsertSetting('billing.late_fee_percentage', 10, tenant, tenant.userId, transaction);

    const schedule2 = await billingScheduleService.generateBillingSchedule(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        contractId: contract.id,
        period: '2027-02',
        dueDate: '2027-02-05',
        items: [{ componentType: 'RENT', amount: 1000 }],
      },
      tenant.userId,
      transaction
    );
    const caseConfigured = await collectionCaseService.openCollectionCase(schedule2.id, daysPastDue, tenant.userId, transaction);
    assert.equal(Number(caseConfigured.penaltyAmount), 100); // 1000 * 10%
  });
});

// --- alterar janela de MFA muda a duração do step-up aplicada ---
test('settings: alterar mfa.step_up_ttl_minutes muda a duração da janela de step-up aplicada em verifyMfa', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const userId = await createSecondUser(suffix);
    await settingsService.upsertSetting('mfa.step_up_ttl_minutes', 1, tenant, tenant.userId, transaction);

    const { otpauthUri } = await mfaService.setupMfa(userId, tenant, transaction);
    const secret = extractSecret(otpauthUri);
    const code = authenticator.generate(secret);
    await mfaService.confirmMfa(userId, code, tenant, transaction);

    const before = Date.now();
    const nextCode = authenticator.generate(secret);
    const { expiresAt } = await mfaService.verifyMfa(userId, nextCode, tenant, transaction);

    const ttlMs = expiresAt.getTime() - before;
    // Deve estar por volta de 1 minuto (tolerância generosa para latência de execução do teste).
    assert.ok(ttlMs > 0 && ttlMs <= 2 * 60 * 1000, `esperado TTL próximo de 1 minuto, obtido ${ttlMs}ms`);
  });
});

module.exports = {};
