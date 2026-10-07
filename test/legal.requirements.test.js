'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction } = require('./testHelpers');
const contractsService = require('../src/features/legal/contracts.service');
const requirementsService = require('../src/features/legal/requirements.service');
const AppError = require('../src/utils/AppError');

let tenant;

before(async () => {
  tenant = await getSeedTenant();
});

after(async () => {
  await sequelize.close();
});

// JUR-TS-003 (Caderno, Anexo I "20. Testes adversariais"): "Documento faltante -> Avançar
// contrato -> Bloqueado." / JUR-003 "Etapa não avança com documento obrigatório faltante."
test('JUR-TS-003: generateRequirementsForContract gera checklist de LEASE e assertRequirementsSatisfied bloqueia com PENDING', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const contract = await contractsService.createContract(
      { groupId: tenant.groupId, companyId: tenant.companyId, contractType: 'LEASE', totalValue: 1000 },
      tenant.userId,
      transaction
    );

    const created = await requirementsService.generateRequirementsForContract(contract.id, {}, tenant.userId, transaction);
    assert.ok(created.length > 0);
    assert.ok(created.every((r) => r.status === 'PENDING'));

    await assert.rejects(
      () => requirementsService.assertRequirementsSatisfied(contract.id, transaction),
      (err) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'LEGAL_REQUIREMENTS_PENDING');
        return true;
      }
    );

    // Idempotente: gerar de novo não duplica.
    const createdAgain = await requirementsService.generateRequirementsForContract(contract.id, {}, tenant.userId, transaction);
    assert.equal(createdAgain.length, 0);
    const all = await requirementsService.listRequirements(contract.id, transaction);
    assert.equal(all.length, created.length);
  });
});

test('satisfyRequirement (SATISFIED/WAIVED) libera assertRequirementsSatisfied', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const contract = await contractsService.createContract(
      { groupId: tenant.groupId, companyId: tenant.companyId, contractType: 'LEASE', totalValue: 1000 },
      tenant.userId,
      transaction
    );
    const created = await requirementsService.generateRequirementsForContract(contract.id, {}, tenant.userId, transaction);

    for (const req of created) {
      await requirementsService.satisfyRequirement(
        req.id,
        req.requirementCode === 'LEASE_OWNERSHIP' ? { waivedReason: 'Titularidade já comprovada em cadastro anterior.' } : { satisfiedByFileId: '11111111-1111-1111-1111-111111111111' },
        tenant.userId,
        transaction
      );
    }

    const result = await requirementsService.assertRequirementsSatisfied(contract.id, transaction);
    assert.equal(result, true);
  });
});

test('generateRequirementsForContract: template USED_PROPERTY_DELIVERY gera termo específico', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const contract = await contractsService.createContract(
      { groupId: tenant.groupId, companyId: tenant.companyId, contractType: 'SALE', totalValue: 500000 },
      tenant.userId,
      transaction
    );
    const created = await requirementsService.generateRequirementsForContract(contract.id, { templateKey: 'USED_PROPERTY_DELIVERY' }, tenant.userId, transaction);
    assert.equal(created.length, 1);
    assert.equal(created[0].requirementCode, 'USED_PROPERTY_TERM');
  });
});
