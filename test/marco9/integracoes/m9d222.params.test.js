'use strict';

// Marco 9, M9-D222 — parâmetro integration.contract.report_validity_days: padrão do parametros.csv, validação da faixa e leitura pelo portão do relatório.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize, getSeedTenant } = require('../../testHelpers');
const settingsService = require('../../../src/features/settings/settings.service');
const { readContractParams } = require('../../../src/features/integrations/contract');

let tenant;
const comTenant = async (fn) => {
  const t = await sequelize.transaction();
  try {
    await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: tenant.groupId }, transaction: t });
    await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: tenant.companyId }, transaction: t });
    await sequelize.query('SET LOCAL app.user_id = :u', { replacements: { u: tenant.userId }, transaction: t });
    const out = await fn(t);
    await t.commit();
    return out;
  } catch (e) { await t.rollback(); throw e; }
};
before(async () => { tenant = await getSeedTenant(); });
after(async () => { await sequelize.close(); });

test('contrato_parametro_validade_do_relatorio', async () => {
  assert.equal((await comTenant((t) => readContractParams(tenant, t))).reportValidityDays, 30);
  await comTenant((t) => settingsService.upsertSetting('integration.contract.report_validity_days', 7, tenant, tenant.userId, t));
  assert.equal((await comTenant((t) => readContractParams(tenant, t))).reportValidityDays, 7);
  await assert.rejects(comTenant((t) => settingsService.upsertSetting('integration.contract.report_validity_days', 0, tenant, tenant.userId, t)), (e) => e.code === 'SETTING_INVALID_VALUE');
  await assert.rejects(comTenant((t) => settingsService.upsertSetting('integration.contract.report_validity_days', 400, tenant, tenant.userId, t)), (e) => e.code === 'SETTING_INVALID_VALUE');
  await comTenant((t) => settingsService.upsertSetting('integration.contract.report_validity_days', 30, tenant, tenant.userId, t));
});
