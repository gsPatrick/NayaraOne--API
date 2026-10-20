'use strict';

// Reconferência 20/10/2026 — R1 (repasse sem conta de saída não podia ser aprovado pela tela) e
// R4 (MFA recente na aprovação/reabertura do fechamento). Tudo em transação com rollback; a
// verificação de MFA é simulada por linhas de mfa_step_ups (NUNCA pelo endpoint de MFA).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix, createTestCostCenter } = require('./testHelpers');
const ownerRepassesService = require('../src/features/finance/ownerRepasses.service');
const financialEntriesService = require('../src/features/finance/financialEntries.service');
const periodClosuresService = require('../src/features/finance/periodClosures.service');
const contractsService = require('../src/features/legal/contracts.service');
const { requireRecentMfa } = require('../src/middlewares/auth.middleware');
const { encryptSecret } = require('../src/utils/mfaCrypto');
const { User, BankAccount, Person, Property, MfaCredential, MfaStepUp } = require('../src/models');

let tenant;
before(async () => { tenant = await getSeedTenant(); });
after(async () => { await sequelize.close(); });

const T = (f) => ({ groupId: tenant.groupId, companyId: tenant.companyId, ...f });

async function makeRepasse(t, { withBank }) {
  const sfx = uniqueSuffix();
  const owner = await Person.create(T({ personType: 'PF', legalName: `Prop R1 ${sfx}`, createdBy: tenant.userId, updatedBy: tenant.userId }), { transaction: t });
  const prop = await Property.create(T({ title: `Imóvel R1 ${sfx}`, internalCode: `R1-${sfx}`, propertyType: 'HOUSE', createdBy: tenant.userId, updatedBy: tenant.userId }), { transaction: t });
  const contract = await contractsService.createContract(T({ contractType: 'LEASE_RESIDENTIAL', propertyId: prop.id, totalValue: 1000 }), tenant.userId, t);
  const { createTestResultCenter } = require('./testHelpers');
  const rc = await createTestResultCenter(tenant, t);
  const e = await financialEntriesService.createFinancialEntry(
    T({ entryType: 'CREDIT', nature: 'RECEIVABLE', amount: 2400, resultCenterId: rc.id, contractId: contract.id, competenceMonth: '2026-11', dueAt: new Date('2026-11-10T12:00:00Z'), description: `Aluguel R1 ${sfx}` }),
    tenant.userId, t
  );
  await financialEntriesService.settleFinancialEntry(e.id, tenant.userId, t);
  const bank = await BankAccount.create(T({ bankCode: '001', agency: '0001', accountNumber: `R1-${sfx}`, status: 'ACTIVE' }), { transaction: t });
  const repasse = await ownerRepassesService.createOwnerRepasse(
    T({ propertyId: prop.id, contractId: contract.id, ownerPersonId: owner.id, bankAccountId: withBank ? bank.id : undefined, referenceMonth: '2026-11', sourceEntryIds: [e.id] }),
    tenant.userId, t
  );
  const checker = await User.create({ email: `r1-checker-${sfx}@nayaraone.dev`, name: 'R1 checker', passwordHash: 'x', status: 'ACTIVE' }, { transaction: t });
  const cc = await createTestCostCenter(tenant, t);
  return { repasse, bank, checker, cc };
}

test('R1: repasse sem conta de saída — recusa com mensagem exata e aprova quando a tela envia a conta', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const { repasse, bank, checker, cc } = await makeRepasse(t, { withBank: false });
    assert.equal(repasse.bankAccountId, null);
    // Era o caso real: a tela mandava só o centro de custo e a API recusava (400) sem a tela mostrar nada.
    await assert.rejects(
      () => ownerRepassesService.approveOwnerRepasse(repasse.id, { costCenterId: cc.id }, checker.id, t),
      (e) => e.code === 'FINANCE_OWNER_REPASSE_BANK_ACCOUNT_REQUIRED' && /Informe a conta bancária de saída/.test(e.message)
    );
    // Recusas de regra (mesma pessoa, centro de custo ausente).
    await assert.rejects(() => ownerRepassesService.approveOwnerRepasse(repasse.id, { costCenterId: cc.id, bankAccountId: bank.id }, tenant.userId, t), (e) => e.code === 'FINANCE_OWNER_REPASSE_SELF_APPROVAL_FORBIDDEN');
    await assert.rejects(() => ownerRepassesService.approveOwnerRepasse(repasse.id, { bankAccountId: bank.id }, checker.id, t), (e) => e.code === 'FINANCE_OWNER_REPASSE_VALIDATION');
    // Caminho feliz com a conta escolhida na tela.
    const { repasse: approved, financialEntry } = await ownerRepassesService.approveOwnerRepasse(repasse.id, { costCenterId: cc.id, bankAccountId: bank.id }, checker.id, t);
    assert.equal(approved.status, 'APPROVED');
    assert.equal(approved.bankAccountId, bank.id);
    assert.equal(financialEntry.nature, 'PAYABLE');
  });
});

async function runGate(t, userId) {
  const req = { auth: { userId }, withTenantTransaction: (fn) => fn(t) };
  let outcome;
  await new Promise((resolve) => requireRecentMfa(req, {}, (err) => { outcome = err || null; resolve(); }));
  return outcome;
}

test('R4: aprovação e reabertura do fechamento têm o portão de MFA recente; sem MFA recente => MFA_STEP_UP_REQUIRED, com => liberado', async () => {
  const routes = fs.readFileSync(path.join(__dirname, '../src/features/finance/finance.routes.js'), 'utf8');
  for (const p of ['approve', 'reopen', 'return-to-open']) {
    const line = routes.split('\n').find((l) => l.includes(`'/finance/period-closures/${p}'`));
    assert.ok(line && line.includes('requireRecentMfa'), `rota ${p} deve exigir MFA recente`);
  }
  await withRollbackTenantTransaction(tenant, async (t) => {
    const user = await User.create({ email: `r4-${uniqueSuffix()}@nayaraone.dev`, name: 'R4', passwordHash: 'x', status: 'ACTIVE', mfaEnabled: true, mfaMethod: 'TOTP' }, { transaction: t });
    await MfaCredential.create(T({ userId: user.id, secretEncrypted: encryptSecret('JBSWY3DPEHPK3PXP'), enabled: true, confirmedAt: new Date(), recoveryCodesHash: [] }), { transaction: t });
    // Sem nenhuma verificação.
    let err = await runGate(t, user.id);
    assert.equal(err && err.code, 'MFA_STEP_UP_REQUIRED');
    // Verificação vencida (há 11 min, janela 10).
    const step = await MfaStepUp.create(T({ userId: user.id, verifiedAt: new Date(Date.now() - 11 * 60000), expiresAt: new Date(Date.now() - 60000) }), { transaction: t });
    err = await runGate(t, user.id);
    assert.equal(err && err.code, 'MFA_STEP_UP_REQUIRED');
    // Verificação recente (há 2 min): passa — o caso da reconferência.
    step.verifiedAt = new Date(Date.now() - 2 * 60000);
    step.expiresAt = new Date(Date.now() + 8 * 60000);
    await step.save({ transaction: t });
    assert.equal(await runGate(t, user.id), null);
  });
});

test('Textos: mensagens do fechamento usam MM/AAAA', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    await assert.rejects(
      () => periodClosuresService.reopenPeriod ? periodClosuresService.reopenPeriod({ groupId: tenant.groupId, companyId: tenant.companyId, referenceMonth: '2071-05', reason: 'motivo suficiente para teste' }, tenant.userId, t) : Promise.reject(new Error('x')),
      (e) => !/2071-05/.test(e.message) && /05\/2071/.test(e.message)
    );
  });
});
