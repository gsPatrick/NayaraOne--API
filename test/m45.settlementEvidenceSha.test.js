'use strict';

// M45 F2: o mesmo comprovante (mesmo conteúdo/SHA-256) enviado duas vezes — dois File distintos —
// não pode ser aceito em outra baixa da mesma empresa.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix, createTestCostCenter } = require('./testHelpers');
const financialEntriesService = require('../src/features/finance/financialEntries.service');
const bankAccountsService = require('../src/features/finance/bankAccounts.service');
const filesService = require('../src/features/files/files.service');

let tenant;
before(async () => { tenant = await getSeedTenant(); });
after(async () => { await sequelize.close(); });

async function newPayable(transaction, suffix, n, costCenterId, bankAccountId) {
  return financialEntriesService.createFinancialEntry(
    {
      groupId: tenant.groupId, companyId: tenant.companyId, bankAccountId, entryType: 'DEBIT', nature: 'PAYABLE',
      amount: 100 + n, description: `QA M45-F2 ${n} ${suffix}`, dueAt: new Date(Date.UTC(2026, 9, 5)),
      competenceMonth: '2026-09', idempotencyKey: `qa-m45f2-${n}-${suffix}`, costCenterId,
    },
    tenant.userId, transaction
  );
}

async function upload(transaction, content, name) {
  return filesService.uploadFile(
    { groupId: tenant.groupId, companyId: tenant.companyId, fileName: name, mimeType: 'image/png', contentBase64: Buffer.from(content).toString('base64'), category: 'generic' },
    tenant.userId, transaction
  );
}

test('M45-F2 comprovante com mesmo SHA-256 (reenvio do arquivo) é recusado em outro lançamento', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const account = await bankAccountsService.createBankAccount(
      { groupId: tenant.groupId, companyId: tenant.companyId, bankCode: '001', agency: '0001', accountNumber: `m45-${suffix}` },
      tenant.userId, transaction
    );
    account.status = 'ACTIVE';
    await account.save({ transaction });
    const cc = await createTestCostCenter(tenant, transaction);
    const e1 = await newPayable(transaction, suffix, 1, cc.id, account.id);
    const e2 = await newPayable(transaction, suffix, 2, cc.id, account.id);
    const e3 = await newPayable(transaction, suffix, 3, cc.id, account.id);
    const content = `PNG-COMPROVANTE-M45-${suffix}`;
    const f1 = await upload(transaction, content, 'comprov_m45_1.png');
    const f2 = await upload(transaction, content, 'comprov_m45_1.png');
    assert.notEqual(f1.id, f2.id);
    const reason = 'Pagamento fora da integração';
    await financialEntriesService.attachSettlementEvidence(e1.id, { evidenceFileId: f1.id, reason }, tenant.userId, transaction);
    await assert.rejects(
      financialEntriesService.attachSettlementEvidence(e2.id, { evidenceFileId: f2.id, reason }, tenant.userId, transaction),
      (err) => err.code === 'FINANCE_SETTLEMENT_EVIDENCE_ALREADY_USED' && err.details?.usedByEntryId === e1.id
    );
    // Conteúdo diferente continua aceito.
    const f3 = await upload(transaction, `${content}-outro`, 'outro.png');
    await financialEntriesService.attachSettlementEvidence(e3.id, { evidenceFileId: f3.id, reason }, tenant.userId, transaction);
    // Reanexar ao MESMO lançamento (mesmo conteúdo) é permitido.
    await financialEntriesService.attachSettlementEvidence(e1.id, { evidenceFileId: f2.id, reason }, tenant.userId, transaction);
  });
});
