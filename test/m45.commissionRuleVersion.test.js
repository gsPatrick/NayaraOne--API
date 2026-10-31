'use strict';

// M45 (varredura de código cru): a tela "Regra de comissão" mostrava o UUID da versão. A API passa
// a devolver o número da versão e o início da vigência.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize, getSeedTenant, withRollbackTenantTransaction } = require('./testHelpers');
const commissionsService = require('../src/features/finance/commissions.service');

let tenant;
before(async () => { tenant = await getSeedTenant(); });
after(async () => { await sequelize.close(); });

test('M45 regra de comissão vigente traz versionNumber e effectiveFrom', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const published = await commissionsService.publishCommissionRuleVersion(
      { groupId: tenant.groupId, companyId: tenant.companyId, componentPercentages: { BROKER: 5.5 } }, tenant.userId, t
    );
    const active = await commissionsService.getActiveCommissionRule(tenant.groupId, tenant.companyId, t);
    assert.equal(active.ruleVersionId, published.id);
    assert.equal(active.versionNumber, published.versionNumber);
    assert.ok(active.effectiveFrom instanceof Date);
    assert.equal(Number(active.components.BROKER), 5.5);
  });
});
