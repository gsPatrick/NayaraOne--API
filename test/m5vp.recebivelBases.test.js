'use strict';

/**
 * Fechamento M5 (vistorias e prazos) — M5-A0105, livro §14 "Valores a receber ficam estimados e vinculados ao Financeiro
 * somente quando juridicamente cabível": o que é cabível é configuração da empresa (bases ligadas/desligadas), não uma lista
 * fixa no código. Padrão = o que valia antes (acordo homologado e sentença transitada em julgado).
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, createTestResultCenter } = require('./testHelpers');
const receivables = require('../src/modules/legal/cases/legalCaseReceivables.service');
const legalCasesService = require('../src/modules/legal/cases/legal-case.service');
const { upsertSetting } = require('../src/features/settings/settings.service');
const { FinancialEntry } = require('../src/models');
const { newCase } = require('./m5fech.juridico.helpers');

let tenant;
before(async () => { tenant = await getSeedTenant(); });
after(async () => { await sequelize.close(); });

const code = (c) => (err) => { assert.equal(err.code, c, `${err.code}: ${err.message}`); return true; };

async function confirmedCase(t, amount) {
  const legalCase = await newCase(tenant, t, { estimatedAmount: amount * 2 });
  await legalCasesService.updateLegalCase(legalCase.id, { confirmedAmount: amount }, tenant.userId, t);
  return legalCase;
}

test('M5-A0105/§14: a base jurídica do recebível segue a configuração da empresa (ligar cumprimento provisório; desligar acordo)', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const rc = await createTestResultCenter(tenant, t);
    const body = (basis) => ({ basis, basisReference: `Ref ${basis}`, dueAt: '2030-03-10', resultCenterId: rc.id });

    const c1 = await confirmedCase(t, 1000);
    await assert.rejects(() => receivables.linkCaseReceivable(c1.id, body('PROVISIONAL_ENFORCEMENT'), tenant.userId, t), (err) => {
      assert.equal(err.code, 'LEGAL_CASE_RECEIVABLE_BASIS_INVALID');
      assert.deepEqual(err.details.acceptedBases, ['SETTLEMENT', 'FINAL_JUDGMENT'], 'padrão = acordo e sentença');
      return true;
    });

    await upsertSetting('legal.processo.recebivel.base.PROVISIONAL_ENFORCEMENT', true, tenant, tenant.userId, t);
    const link = await receivables.linkCaseReceivable(c1.id, body('PROVISIONAL_ENFORCEMENT'), tenant.userId, t);
    const entry = await FinancialEntry.findByPk(link.financialEntryId, { transaction: t });
    assert.equal(link.basis, 'PROVISIONAL_ENFORCEMENT');
    assert.match(entry.description, /cumprimento provisório de sentença/);

    await upsertSetting('legal.processo.recebivel.base.SETTLEMENT', false, tenant, tenant.userId, t);
    const c2 = await confirmedCase(t, 2000);
    await assert.rejects(() => receivables.linkCaseReceivable(c2.id, body('SETTLEMENT'), tenant.userId, t), code('LEGAL_CASE_RECEIVABLE_BASIS_INVALID'));
    const ok = await receivables.linkCaseReceivable(c2.id, body('FINAL_JUDGMENT'), tenant.userId, t);
    assert.equal(ok.basis, 'FINAL_JUDGMENT');
    await assert.rejects(() => receivables.linkCaseReceivable(c2.id, body('INVENTADA'), tenant.userId, t), code('LEGAL_CASE_RECEIVABLE_BASIS_INVALID'));
  });
});
