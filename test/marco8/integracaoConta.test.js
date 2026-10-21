'use strict';

// Marco 8 — a falha de integração fica em correspondent.integration_errors,
// e a conta do provider guarda só a referência do cofre.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('../testHelpers');
const financingCasesService = require('../../src/features/correspondent/cases/financingCases.service');
const submissionsService = require('../../src/features/correspondent/cases/submissions.service');
const providerAccountsService = require('../../src/features/correspondent/providerAccounts.service');
const { SandboxFinancingProviderAdapter } = require('../../src/features/correspondent/adapters/FinancingProviderAdapter');
const { Person, IntegrationError, ProviderAccount, AuditLog } = require('../../src/models');

const SEGREDO = 'token-da-prova-nao-pode-gravar';

let tenant;

before(async () => {
  tenant = await getSeedTenant();
});

after(async () => {
  await sequelize.close();
});

async function criarPessoa(transaction) {
  return Person.create(
    {
      groupId: tenant.groupId,
      companyId: tenant.companyId,
      personType: 'PF',
      legalName: `Proponente M8 ${uniqueSuffix()}`,
      createdBy: tenant.userId,
      updatedBy: tenant.userId,
    },
    { transaction }
  );
}

test('M8-INT-01: falha no envio grava erro de integração sem o texto do provider', async () => {
  const original = SandboxFinancingProviderAdapter.prototype.submitCase;
  SandboxFinancingProviderAdapter.prototype.submitCase = async () => {
    throw new Error(`provider recusou ${SEGREDO}`);
  };
  try {
    await withRollbackTenantTransaction(tenant, async (transaction) => {
      const pessoa = await criarPessoa(transaction);
      const financingCase = await financingCasesService.createFinancingCase(
        {
          groupId: tenant.groupId,
          companyId: tenant.companyId,
          applicants: [{ personId: pessoa.id, role: 'PRINCIPAL' }],
        },
        tenant.userId,
        transaction
      );
      const submission = await submissionsService.submitFinancingCase(
        financingCase.id,
        { amount: 200000, consent: true },
        tenant.userId,
        tenant.groupId,
        tenant.companyId,
        transaction
      );
      assert.equal(submission.status, 'UNKNOWN');
      const row = await IntegrationError.findOne({
        where: { financingCaseId: financingCase.id, operation: 'submit' },
        transaction,
      });
      assert.ok(row, 'integration_errors da submissão');
      assert.equal(row.errorCode, 'SUBMIT_FAILED');
      assert.equal(row.providerCode, 'sandbox');
      const gravado = JSON.stringify(row.toJSON());
      assert.equal(gravado.includes(SEGREDO), false);
      assert.equal(gravado.includes('stack'), false);
    });
  } finally {
    SandboxFinancingProviderAdapter.prototype.submitCase = original;
  }
});

test('M8-SEC-01: conta de provider recusa o segredo e grava só a referência do cofre', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    await assert.rejects(
      () => providerAccountsService.registerProviderAccount(
        {
          groupId: tenant.groupId,
          companyId: tenant.companyId,
          providerCode: 'sandbox',
          label: 'Sandbox',
          secretRef: 'vault:correspondent/sandbox',
          secret: SEGREDO,
        },
        tenant.userId,
        transaction
      ),
      (err) => err.code === 'PROVIDER_ACCOUNT_SECRET_FORBIDDEN'
    );
    const vazios = await ProviderAccount.findAll({ where: { companyId: tenant.companyId, label: 'Sandbox' }, transaction });
    assert.equal(vazios.length, 0);

    const account = await providerAccountsService.registerProviderAccount(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        providerCode: 'sandbox',
        label: 'Sandbox cofre',
        secretRef: 'vault:correspondent/sandbox',
      },
      tenant.userId,
      transaction
    );
    assert.equal(account.secretRef, 'vault:correspondent/sandbox');
    const row = await AuditLog.findOne({
      where: { action: 'correspondent.provider_account.created', entityId: account.id },
      transaction,
    });
    assert.ok(row);
    assert.ok(JSON.stringify(row.beforeJson).includes('Não existia'));
    assert.equal(row.afterJson.secretRef, 'vault:correspondent/sandbox');
    assert.equal(JSON.stringify(row.toJSON()).includes(SEGREDO), false);
  });
});
