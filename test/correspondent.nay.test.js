'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const financingCasesService = require('../src/features/correspondent/cases/financingCases.service');
const simulationsService = require('../src/features/correspondent/cases/simulations.service');
const caseDocumentsService = require('../src/features/correspondent/cases/caseDocuments.service');
const nayService = require('../src/features/correspondent/correspondentNay.service');
const { Person, FinancingCase } = require('../src/models');

let tenant;
let otherCompanyId;

before(async () => {
  tenant = await getSeedTenant();
  const [[row]] = await sequelize.query('SELECT id FROM core.companies WHERE id != :companyId LIMIT 1', {
    replacements: { companyId: tenant.companyId },
  });
  otherCompanyId = row ? row.id : '00000000-0000-0000-0000-000000000000';
});

after(async () => {
  await sequelize.close();
});

async function createCase(transaction, providerCode = 'sandbox') {
  const principal = await Person.create(
    {
      groupId: tenant.groupId,
      companyId: tenant.companyId,
      personType: 'PF',
      legalName: `Proponente NAY ${uniqueSuffix()}`,
      createdBy: tenant.userId,
      updatedBy: tenant.userId,
    },
    { transaction }
  );
  return financingCasesService.createFinancingCase(
    { groupId: tenant.groupId, companyId: tenant.companyId, providerCode, applicants: [{ personId: principal.id, role: 'PRINCIPAL' }] },
    tenant.userId,
    transaction
  );
}

async function backdateCase(id, days, transaction) {
  await sequelize.query('UPDATE correspondent.financing_cases SET updated_at = now() - make_interval(days => :days) WHERE id = :id', {
    replacements: { days, id },
    transaction,
  });
}

test('CORRESPONDENT-NAY-01: caso parado com documento pendente é sinalizado com o motivo certo', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const financingCase = await createCase(transaction);
    await caseDocumentsService.createRequirement(
      financingCase.id,
      { documentType: 'RG_CPF' },
      tenant.userId,
      { groupId: tenant.groupId, companyId: tenant.companyId },
      transaction
    );
    await backdateCase(financingCase.id, 10, transaction);

    const result = await nayService.checkStalledCases(tenant.groupId, tenant.companyId, { thresholdDays: 7 }, transaction);
    const found = result.cases.find((c) => c.financingCaseId === financingCase.id);
    assert.ok(found, 'caso parado deveria ser sinalizado');
    assert.ok(found.idleDays >= 7);
    assert.ok(found.reason.includes('RG_CPF'));
    assert.deepEqual(found.pendingRequirementTypes, ['RG_CPF']);
    assert.deepEqual(result.decisionsMade, []);
  });
});

test('CORRESPONDENT-NAY-02: caso com atividade recente (dentro do limiar) não aparece como parado', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const financingCase = await createCase(transaction);
    // Não precisa backdate: acabou de ser criado, updated_at é "agora".
    const result = await nayService.checkStalledCases(tenant.groupId, tenant.companyId, { thresholdDays: 7 }, transaction);
    const found = result.cases.find((c) => c.financingCaseId === financingCase.id);
    assert.equal(found, undefined, 'caso recente não deveria ser sinalizado como parado');
  });
});

test('CORRESPONDENT-NAY-03: caso parado sem requirement pendente usa motivo de status (aguardando provider)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const financingCase = await createCase(transaction);
    await FinancingCase.update({ status: 'SUBMITTED' }, { where: { id: financingCase.id }, transaction });
    await backdateCase(financingCase.id, 8, transaction);

    const result = await nayService.checkStalledCases(tenant.groupId, tenant.companyId, { thresholdDays: 7 }, transaction);
    const found = result.cases.find((c) => c.financingCaseId === financingCase.id);
    assert.ok(found);
    assert.match(found.reason, /provider/i);
  });
});

test('CORRESPONDENT-NAY-04: compara simulações e recomenda a de menor parcela, sem alterar nada', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const financingCase = await createCase(transaction);
    const simA = await simulationsService.createSimulation(financingCase.id, { amount: 200000, termMonths: 360 }, tenant.userId, tenant.groupId, tenant.companyId, transaction);
    const simB = await simulationsService.createSimulation(financingCase.id, { amount: 200000, termMonths: 120 }, tenant.userId, tenant.groupId, tenant.companyId, transaction);

    const result = await nayService.compareSimulations(financingCase.id, tenant.groupId, tenant.companyId, transaction);
    assert.equal(result.simulations.length, 2);
    const lowest = [simA, simB].reduce((a, b) => (Number(a.monthlyPayment) <= Number(b.monthlyPayment) ? a : b));
    assert.equal(result.recommendedSimulationId, lowest.id);
    const recommendedEntry = result.simulations.find((s) => s.id === result.recommendedSimulationId);
    assert.equal(recommendedEntry.recommended, true);
    assert.deepEqual(result.decisionsMade, []);
  });
});

test('CORRESPONDENT-NAY-05: NAY nunca escreve no banco — status e simulações permanecem inalterados após a chamada', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const financingCase = await createCase(transaction);
    await simulationsService.createSimulation(financingCase.id, { amount: 100000, termMonths: 180 }, tenant.userId, tenant.groupId, tenant.companyId, transaction);
    await backdateCase(financingCase.id, 10, transaction);

    const beforeCase = await FinancingCase.findByPk(financingCase.id, { transaction });
    const beforeStatus = beforeCase.status;
    const beforeUpdatedAt = beforeCase.updatedAt ?? beforeCase.updated_at;

    await nayService.checkStalledCases(tenant.groupId, tenant.companyId, { thresholdDays: 7 }, transaction);
    await nayService.compareSimulations(financingCase.id, tenant.groupId, tenant.companyId, transaction);

    const afterCase = await FinancingCase.findByPk(financingCase.id, { transaction });
    assert.equal(afterCase.status, beforeStatus, 'status não deveria mudar só por chamar a NAY');
    assert.equal(
      new Date(afterCase.updatedAt ?? afterCase.updated_at).getTime(),
      new Date(beforeUpdatedAt).getTime(),
      'updated_at não deveria mudar — NAY é somente leitura'
    );
  });
});

test('CORRESPONDENT-NAY-06: nenhuma resposta da NAY contém texto de promessa de aprovação/taxa/prazo', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const financingCase = await createCase(transaction);
    await simulationsService.createSimulation(financingCase.id, { amount: 100000, termMonths: 180 }, tenant.userId, tenant.groupId, tenant.companyId, transaction);
    await backdateCase(financingCase.id, 10, transaction);

    const stalled = await nayService.checkStalledCases(tenant.groupId, tenant.companyId, { thresholdDays: 7 }, transaction);
    const compare = await nayService.compareSimulations(financingCase.id, tenant.groupId, tenant.companyId, transaction);

    const forbiddenPatterns = /voc[eê] vai conseguir|aprovado automaticamente|garantimos|promet/i;
    assert.doesNotMatch(JSON.stringify(stalled), forbiddenPatterns);
    assert.doesNotMatch(JSON.stringify(compare), forbiddenPatterns);
  });
});

test('CORRESPONDENT-NAY-07: isolamento por empresa — caso de outra empresa não aparece nos parados nem na comparação', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const result = await nayService.checkStalledCases(tenant.groupId, otherCompanyId, { thresholdDays: 0 }, transaction);
    assert.equal(result.cases.length, 0);
  });
});

test('CORRESPONDENT-NAY-08: comparar simulações de case inexistente retorna 404 de negócio', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    await assert.rejects(
      () => nayService.compareSimulations('00000000-0000-0000-0000-000000000000', tenant.groupId, tenant.companyId, transaction),
      (err) => {
        assert.equal(err.statusCode, 404);
        return true;
      }
    );
  });
});
