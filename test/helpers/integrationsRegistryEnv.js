'use strict';

// Apoio comum dos testes do registro de integração (M9-D200): tenants do seed, MFA de produção desligado,
// limpeza das configurações ao final e as fábricas/asserções usadas pelas provas.

const assert = require('node:assert/strict');
const { sequelize, getSeedTenant, uniqueSuffix } = require('../testHelpers');
const { Group, Company } = require('../../src/models');
const settingsService = require('../../src/features/settings/settings.service');

async function setupEnv() {
  const tenant = await getSeedTenant();
  const ctx = { groupId: tenant.groupId, companyId: tenant.companyId, userId: tenant.userId };
  let otherTenant;
  const grupoB = await Group.findOne({ where: { name: 'CI — Grupo Fictício B' } });
  if (grupoB) {
    const empresaB = await sequelize.transaction(async (t) => {
      await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: grupoB.id }, transaction: t });
      return Company.findOne({ where: { groupId: grupoB.id, name: 'CI — Empresa Fictícia B' }, transaction: t });
    });
    if (empresaB) otherTenant = { groupId: grupoB.id, companyId: empresaB.id, userId: tenant.userId };
  }
  // Estas provas não são sobre MFA: desliga o MFA recente em produção (o teste 11 religa).
  await sequelize.transaction(async (t) => {
    await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: tenant.groupId }, transaction: t });
    await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: tenant.companyId }, transaction: t });
    await settingsService.upsertSetting('integration.admin.mfa_on_prod_connection_change', false, tenant, tenant.userId, t);
  });
  return { tenant, ctx, otherTenant };
}

async function teardownEnv(tenant) {
  await sequelize.transaction(async (t) => {
    await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: tenant.groupId }, transaction: t });
    await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: tenant.companyId }, transaction: t });
    await sequelize.query(`DELETE FROM core.tenant_settings WHERE company_id = :c AND key LIKE 'integration.%'`, { replacements: { c: tenant.companyId }, transaction: t });
  });
}

function novaConexao(over = {}) {
  return { providerCode: 'financing-manual', environment: 'SANDBOX', label: `QA-M9 ${uniqueSuffix()}`, ...over };
}

async function comPlataforma(transaction) {
  await sequelize.query("SET LOCAL app.integration_platform_admin = 'on'", { transaction });
}

async function recusa(promessa, code, status) {
  await assert.rejects(promessa, (err) => {
    assert.equal(err.code, code);
    if (status) assert.equal(err.statusCode ?? err.status, status);
    return true;
  });
}

module.exports = { setupEnv, teardownEnv, novaConexao, comPlataforma, recusa };
