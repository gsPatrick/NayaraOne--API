'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { authenticator } = require('otplib');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const mfaService = require('../src/features/users/mfa.service');
const approvalsService = require('../src/features/finance/approvals.service');
const financialEntriesService = require('../src/features/finance/financialEntries.service');
const { User } = require('../src/models');
const AppError = require('../src/utils/AppError');

let tenant;

before(async () => {
  tenant = await getSeedTenant();
});

after(async () => {
  await sequelize.close();
});

function extractSecret(otpauthUri) {
  const match = /[?&]secret=([^&]+)/.exec(otpauthUri);
  if (!match) throw new Error('otpauth:// sem secret na URI');
  return match[1];
}

async function setupAndConfirmMfa(transaction, userId) {
  const { otpauthUri } = await mfaService.setupMfa(userId, tenant, transaction);
  const secret = extractSecret(otpauthUri);
  const code = authenticator.generate(secret);
  const { recoveryCodes } = await mfaService.confirmMfa(userId, code, tenant, transaction);
  return { secret, recoveryCodes };
}

async function createSecondUser(suffix) {
  const [user] = await User.findOrCreate({
    where: { email: `homo-qa-mfa-${suffix}@nayaraone.dev` },
    defaults: { name: `HOMO QA — MFA ${suffix}`, passwordHash: 'x', status: 'ACTIVE' },
  });
  return user.id;
}

test('MFA-001 setup + confirm habilita MFA e retorna códigos de recuperação em texto plano uma única vez', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const userId = await createSecondUser(suffix);
    const { recoveryCodes } = await setupAndConfirmMfa(transaction, userId);

    assert.equal(recoveryCodes.length, 8);
    const user = await User.findByPk(userId, { transaction });
    assert.equal(user.mfaEnabled, true);
    assert.equal(user.mfaMethod, 'TOTP');
  });
});

test('MFA-002 verify com código TOTP errado falha com MFA_INVALID_CODE', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const userId = await createSecondUser(suffix);
    await setupAndConfirmMfa(transaction, userId);

    await assert.rejects(
      () => mfaService.verifyMfa(userId, '000000', tenant, transaction),
      (err) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'MFA_INVALID_CODE');
        return true;
      }
    );
  });
});

test('MFA-003 verify com código certo abre a janela de step-up (hasRecentMfa true)', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const userId = await createSecondUser(suffix);
    const { secret } = await setupAndConfirmMfa(transaction, userId);

    assert.equal(await mfaService.hasRecentMfa(userId, transaction), false);
    const code = authenticator.generate(secret);
    await mfaService.verifyMfa(userId, code, tenant, transaction);
    assert.equal(await mfaService.hasRecentMfa(userId, transaction), true);
  });
});

test('MFA-004 ação de alto risco (decideApprovalStep, riskLevel HIGH) sem step-up recente é bloqueada', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const approverUserId = await createSecondUser(suffix);
    await setupAndConfirmMfa(transaction, approverUserId); // MFA habilitado mas SEM verify recente

    const entry = await financialEntriesService.createFinancialEntry(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        entryType: 'DEBIT',
        nature: 'PAYABLE',
        amount: 100,
        description: 'HOMO QA — lançamento MFA',
      },
      tenant.userId,
      transaction
    );
    const request = await approvalsService.createApprovalRequest(
      { groupId: tenant.groupId, companyId: tenant.companyId, relatedEntityType: 'FinancialEntry', relatedEntityId: entry.id, riskLevel: 'HIGH' },
      tenant.userId,
      transaction
    );

    await assert.rejects(
      () => approvalsService.decideApprovalStep(request.id, { decision: 'APPROVED' }, approverUserId, transaction),
      (err) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'MFA_STEP_UP_REQUIRED');
        return true;
      }
    );
  });
});

test('MFA-005 ação de alto risco com step-up recente é permitida', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const approverUserId = await createSecondUser(suffix);
    const { secret } = await setupAndConfirmMfa(transaction, approverUserId);
    await mfaService.verifyMfa(approverUserId, authenticator.generate(secret), tenant, transaction);

    const entry = await financialEntriesService.createFinancialEntry(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        entryType: 'DEBIT',
        nature: 'PAYABLE',
        amount: 100,
        description: 'HOMO QA — lançamento MFA permitido',
      },
      tenant.userId,
      transaction
    );
    const request = await approvalsService.createApprovalRequest(
      { groupId: tenant.groupId, companyId: tenant.companyId, relatedEntityType: 'FinancialEntry', relatedEntityId: entry.id, riskLevel: 'HIGH' },
      tenant.userId,
      transaction
    );

    const { step } = await approvalsService.decideApprovalStep(request.id, { decision: 'APPROVED' }, approverUserId, transaction);
    assert.equal(step.decision, 'APPROVED');
  });
});

test('MFA-006 código de recuperação de uso único não pode ser reusado', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const userId = await createSecondUser(suffix);
    const { recoveryCodes } = await setupAndConfirmMfa(transaction, userId);
    const code = recoveryCodes[0];

    const result = await mfaService.verifyMfa(userId, code, tenant, transaction);
    assert.equal(result.usedRecoveryCode, true);

    await assert.rejects(
      () => mfaService.verifyMfa(userId, code, tenant, transaction),
      (err) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'MFA_INVALID_CODE');
        return true;
      }
    );
  });
});

test('MFA-007 ação de alto risco sem MFA habilitado é bloqueada pedindo habilitar primeiro', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const approverUserId = await createSecondUser(suffix); // nunca configurou MFA

    const entry = await financialEntriesService.createFinancialEntry(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        entryType: 'DEBIT',
        nature: 'PAYABLE',
        amount: 100,
        description: 'HOMO QA — lançamento sem MFA',
      },
      tenant.userId,
      transaction
    );
    const request = await approvalsService.createApprovalRequest(
      { groupId: tenant.groupId, companyId: tenant.companyId, relatedEntityType: 'FinancialEntry', relatedEntityId: entry.id, riskLevel: 'CRITICAL' },
      tenant.userId,
      transaction
    );

    await assert.rejects(
      () => approvalsService.decideApprovalStep(request.id, { decision: 'APPROVED' }, approverUserId, transaction),
      (err) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'MFA_REQUIRED_NOT_ENABLED');
        return true;
      }
    );
  });
});
