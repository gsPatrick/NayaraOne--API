'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const { Property } = require('../src/models');
const maintenanceCasesService = require('../src/features/construction/maintenanceCases.service');
const slaRulesService = require('../src/features/construction/slaRules.service');

let tenant;

before(async () => {
  tenant = await getSeedTenant();
});

after(async () => {
  await sequelize.close();
});

async function createTestProperty(transaction) {
  const suffix = uniqueSuffix();
  return Property.create(
    {
      groupId: tenant.groupId,
      companyId: tenant.companyId,
      title: `Imóvel de teste SLA ${suffix}`,
      internalCode: `SLA-${suffix}`,
      propertyType: 'HOUSE',
      createdBy: tenant.userId,
      updatedBy: tenant.userId,
    },
    { transaction }
  );
}

// GAP CORRIGIDO (auditoria pós-Marco 6, item 1): o prazo padrão de pós-obra (SEVERITY_SLA_DAYS)
// era uma constante hardcoded — migrado pro Motor de Regras genérico com o código REG-OBR-002
// do catálogo do contrato (mesmo padrão de REG-OBR-001/marginRules.service.js).

test('REG-OBR-002: SLA default (seed automático) bate com os valores anteriores (CRITICAL=2, HIGH=5, MEDIUM=15, LOW=30)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { Rule: RuleModel, RuleVersion: RuleVersionModel } = require('../src/models');

    const property = await createTestProperty(transaction);

    const cases = {};
    for (const severity of ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']) {
      cases[severity] = await maintenanceCasesService.createMaintenanceCase(
        {
          groupId: tenant.groupId,
          companyId: tenant.companyId,
          propertyId: property.id,
          description: `Caso de teste SLA default — ${severity}.`,
          severity,
        },
        tenant.userId,
        transaction
      );
    }

    const expectedDays = { CRITICAL: 2, HIGH: 5, MEDIUM: 15, LOW: 30 };
    for (const severity of Object.keys(expectedDays)) {
      const expectedDueAt = new Date(Date.now() + expectedDays[severity] * 24 * 60 * 60 * 1000);
      const diffMs = Math.abs(new Date(cases[severity].slaDueAt).getTime() - expectedDueAt.getTime());
      assert.ok(diffMs < 20000, `SLA de ${severity} deveria bater com o default de ${expectedDays[severity]} dias (diff=${diffMs}ms)`);
    }

    // O seed automático precisa ter criado uma Rule/RuleVersion real com o código REG-OBR-002.
    const rule = await RuleModel.findOne({ where: { code: 'REG-OBR-002', groupId: tenant.groupId, companyId: tenant.companyId }, transaction });
    assert.ok(rule, 'esperava uma Rule real com code="REG-OBR-002" no Motor de Regras genérico');
    const version = await RuleVersionModel.findOne({ where: { ruleId: rule.id, status: 'PUBLISHED', effectiveUntil: null }, transaction });
    assert.ok(version, 'esperava uma RuleVersion PUBLISHED vigente');
    assert.deepEqual(version.actionJson.slaDays, expectedDays);
  });
});

test('REG-OBR-002: publicar nova versão da regra passa a valer pra casos novos, preservando o SLA já calculado dos casos existentes', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const property = await createTestProperty(transaction);

    // Garante que a regra default já existe (idêntico ao primeiro teste) antes de criar o caso
    // "antigo" com os valores default.
    const oldCase = await maintenanceCasesService.createMaintenanceCase(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        propertyId: property.id,
        description: 'Caso aberto ANTES da nova versão de SLA.',
        severity: 'HIGH',
      },
      tenant.userId,
      transaction
    );
    const oldSlaDueAt = new Date(oldCase.slaDueAt).getTime();
    const oldExpectedDueAt = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).getTime(); // HIGH default = 5 dias
    assert.ok(Math.abs(oldSlaDueAt - oldExpectedDueAt) < 5000, 'caso antigo deveria ter usado o SLA default (HIGH=5 dias)');

    // Publica uma NOVA versão da regra com dias diferentes.
    const newSlaDays = { CRITICAL: 1, HIGH: 20, MEDIUM: 40, LOW: 60 };
    const newVersion = await slaRulesService.createSlaRule(
      { groupId: tenant.groupId, companyId: tenant.companyId, slaDays: newSlaDays, description: 'Nova política de SLA (teste).' },
      tenant.userId,
      transaction
    );
    assert.ok(newVersion.id, 'createSlaRule deveria retornar o id da nova RuleVersion');

    // Caso aberto DEPOIS da nova versão usa os novos dias.
    const newCase = await maintenanceCasesService.createMaintenanceCase(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        propertyId: property.id,
        description: 'Caso aberto DEPOIS da nova versão de SLA.',
        severity: 'HIGH',
      },
      tenant.userId,
      transaction
    );
    const newSlaDueAt = new Date(newCase.slaDueAt).getTime();
    const newExpectedDueAt = new Date(Date.now() + 20 * 24 * 60 * 60 * 1000).getTime(); // HIGH novo = 20 dias
    assert.ok(Math.abs(newSlaDueAt - newExpectedDueAt) < 5000, 'caso novo deveria usar o novo SLA (HIGH=20 dias)');

    // O caso ANTIGO, relido do banco, preserva o slaDueAt calculado no momento em que foi
    // aberto — publicar uma nova versão NUNCA reescreve silenciosamente casos já existentes.
    const reloaded = await maintenanceCasesService.getMaintenanceCase(oldCase.id, transaction);
    assert.equal(new Date(reloaded.slaDueAt).getTime(), oldSlaDueAt, 'slaDueAt do caso antigo não deveria mudar retroativamente');

    // E a versão da regra do caso antigo (resolvida na época) é diferente da versão atual.
    const activeNow = await slaRulesService.getActiveSlaDaysMap(tenant.groupId, tenant.companyId, transaction);
    assert.equal(activeNow.ruleVersionId, newVersion.id);
    assert.deepEqual(activeNow.slaDays, newSlaDays);
  });
});
