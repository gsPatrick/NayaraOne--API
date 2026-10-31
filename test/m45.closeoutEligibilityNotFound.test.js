'use strict';

// Evidência ao vivo de 19/10/2026 (Marcos 4/5): GET /billing/contracts/:id/closeout-eligibility
// devolvia eligible:true para um contrato inexistente. JUR-015 manda falhar fechado.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize, getSeedTenant, withRollbackTenantTransaction } = require('./testHelpers');
const closeoutService = require('../src/features/billing/closeout.service');

let tenant;
before(async () => { tenant = await getSeedTenant(); });
after(async () => { await sequelize.close(); });

test('M45-CLOSEOUT-01: elegibilidade de encerramento de contrato inexistente é 404 CLOSEOUT_CONTRACT_NOT_FOUND, nunca "elegível"', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    await assert.rejects(
      () => closeoutService.checkCloseoutEligibility('00000000-0000-4000-8000-000000000000', t),
      (err) => err.code === 'CLOSEOUT_CONTRACT_NOT_FOUND' && err.statusCode === 404
    );
  });
});
