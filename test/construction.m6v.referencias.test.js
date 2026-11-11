'use strict';

// Verificação independente do Marco 6 — referências por chave estrangeira de Obras sempre da MESMA empresa (FK no
// PostgreSQL ignora RLS). M6-08 (prestador e documentação do RDO), M6-95 (unidade da obra), M6-104 (obra do contrato de
// empreitada) e a varredura dos serviços de Obras: cada referência de outra empresa é recusada com 422
// CONSTRUCTION_REFERENCE_NOT_IN_COMPANY e nada é gravado.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./testHelpers');
const { W, inOtherCompany, createMember, evidenceIds } = require('./constructionM6vFixture');
const { DailyWorker, Person, Unit, File, Project, InventoryLocation } = require('../src/models');
const projectsService = require('../src/features/construction/projects.service');
const projectStagesService = require('../src/features/construction/projectStages.service');
const dailyReportsService = require('../src/features/construction/dailyReports.service');
const nonconformitiesService = require('../src/features/construction/nonconformities.service');
const budgetLinesService = require('../src/features/construction/budgetLines.service');
const maintenanceCasesService = require('../src/features/construction/maintenanceCases.service');
const contractService = require('../src/modules/legal/contracts/application/contract.service');
const financialEntriesService = require('../src/modules/finance/application/services/financial-entry.service');
const itemsService = require('../src/features/inventory/items.service');
const peopleService = require('../src/features/people/people.service');
const propertiesService = require('../src/features/properties/properties.service');

let tenant;
before(async () => {
  tenant = await H.getSeedTenant();
});
after(async () => {
  await H.sequelize.close();
});

const REF = { code: 'CONSTRUCTION_REFERENCE_NOT_IN_COMPANY' };
const novaObra = (t, extra = {}) => projectsService.createProject(W(tenant, { name: `M6V ref ${H.uniqueSuffix()}`, ...extra }), tenant.userId, t);

test('M6-08: documento do prestador no RDO precisa ser arquivo real da empresa, examinado pelo antivírus', async () => {
  await H.withRollbackTenantTransaction(tenant, async (t) => {
    const project = await novaObra(t);
    const worker = await peopleService.createPerson(W(tenant, { personType: 'PF', legalName: `Prestador M6V ${H.uniqueSuffix()}` }), tenant.userId, t);
    const foto = await evidenceIds(tenant, t, 1, 'rdo');
    const FAKE = '99999999-9999-4999-8999-999999999999';
    await assert.rejects(
      dailyReportsService.createDailyReport(project.id, W(tenant, { reportDate: '2026-11-04', evidenceFileIds: foto, workers: [{ personId: worker.id, role: 'Pedreiro', documentFileIds: [FAKE] }] }), tenant.userId, t),
      { code: 'CONSTRUCTION_EVIDENCE_FILE_NOT_FOUND' }
    );
    const alheio = await inOtherCompany(tenant, t, async (other) => (await evidenceIds({ ...tenant, companyId: other.id }, t, 1, 'alheio'))[0]);
    await assert.rejects(
      dailyReportsService.createDailyReport(project.id, W(tenant, { reportDate: '2026-11-05', evidenceFileIds: foto, workers: [{ personId: worker.id, documentFileIds: [alheio] }] }), tenant.userId, t),
      { code: 'CONSTRUCTION_EVIDENCE_FILE_NOT_FOUND' }
    );
    // Documento real, mas sem exame do antivírus (arquivo antigo, scan_status nulo): recusado.
    const [semExame] = await evidenceIds(tenant, t, 1, 'sem-exame');
    await File.update({ scanStatus: null }, { where: { id: semExame }, transaction: t });
    await assert.rejects(
      dailyReportsService.createDailyReport(project.id, W(tenant, { reportDate: '2026-11-06', evidenceFileIds: foto, workers: [{ personId: worker.id, documentFileIds: [semExame] }] }), tenant.userId, t),
      { code: 'CONSTRUCTION_EVIDENCE_FILE_NOT_SCANNED' }
    );
    const [doc] = await evidenceIds(tenant, t, 1, 'documento');
    const rdo = await dailyReportsService.createDailyReport(project.id, W(tenant, { reportDate: '2026-11-07', evidenceFileIds: foto, workers: [{ personId: worker.id, role: 'Pedreiro', documentFileIds: [doc] }] }), tenant.userId, t);
    const gravado = await DailyWorker.findOne({ where: { dailyReportId: rdo.id }, transaction: t });
    assert.deepEqual(gravado.documentFileIds, [doc]);
  });
});

test('M6-08: prestador de OUTRA empresa não entra na equipe do RDO (nada gravado)', async () => {
  await H.withRollbackTenantTransaction(tenant, async (t) => {
    const project = await novaObra(t);
    const alheio = await inOtherCompany(tenant, t, (other) => Person.create({ groupId: tenant.groupId, companyId: other.id, personType: 'PF', legalName: `Prestador alheio ${H.uniqueSuffix()}`, status: 'ACTIVE' }, { transaction: t }));
    await assert.rejects(
      dailyReportsService.createDailyReport(project.id, W(tenant, { reportDate: '2026-11-08', evidenceFileIds: await evidenceIds(tenant, t), workers: [{ personId: alheio.id, role: 'Pedreiro' }] }), tenant.userId, t),
      REF
    );
    assert.equal(await DailyWorker.count({ where: { personId: alheio.id }, transaction: t }), 0);
  });
});

test('M6-95: obra não aceita unidade, imóvel nem responsável de outra empresa; tipo de obra também é conferido', async () => {
  await H.withRollbackTenantTransaction(tenant, async (t) => {
    const { unidade, imovel, estranho } = await inOtherCompany(tenant, t, async (other) => ({
      unidade: await Unit.create({ groupId: tenant.groupId, companyId: other.id, name: `Unidade alheia ${H.uniqueSuffix()}`, status: 'ACTIVE' }, { transaction: t }),
      imovel: await propertiesService.createProperty({ groupId: tenant.groupId, companyId: other.id, title: `Imóvel alheio ${H.uniqueSuffix()}`, internalCode: `ALH-${H.uniqueSuffix()}`, propertyType: 'RESIDENTIAL' }, tenant.userId, t),
      estranho: await createMember(tenant, t, { companyId: other.id }),
    }));
    const antes = await Project.count({ transaction: t });
    await assert.rejects(novaObra(t, { unitId: unidade.id }), REF);
    await assert.rejects(novaObra(t, { propertyId: imovel.id }), REF);
    await assert.rejects(novaObra(t, { responsibleUserId: estranho.id }), REF);
    assert.equal(await Project.count({ transaction: t }), antes, 'nenhuma obra gravada');
    const inativo = await createMember(tenant, t, { status: 'INACTIVE' });
    await assert.rejects(novaObra(t, { responsibleUserId: inativo.id }), REF);
    const obra = await novaObra(t);
    await assert.rejects(projectsService.updateProject(obra.id, { unitId: unidade.id }, tenant.userId, t), REF);
    const minhaUnidade = await Unit.create({ groupId: tenant.groupId, companyId: tenant.companyId, name: `Unidade ${H.uniqueSuffix()}`, status: 'ACTIVE' }, { transaction: t });
    const ok = await projectsService.updateProject(obra.id, { unitId: minhaUnidade.id }, tenant.userId, t);
    assert.equal(ok.unitId, minhaUnidade.id);
  });
});

test('M6-104: contrato de empreitada não é vinculado a obra de OUTRA empresa; da mesma empresa, sim', async () => {
  await H.withRollbackTenantTransaction(tenant, async (t) => {
    const obraAlheia = await inOtherCompany(tenant, t, (other) => projectsService.createProject({ groupId: tenant.groupId, companyId: other.id, name: `Obra alheia ${H.uniqueSuffix()}` }, tenant.userId, t));
    await assert.rejects(contractService.createContract(W(tenant, { contractType: 'CONSTRUCTION', constructionProjectId: obraAlheia.id, totalValue: 1000 }), tenant.userId, t), REF);
    const minha = await novaObra(t);
    const c = await contractService.createContract(W(tenant, { contractType: 'CONSTRUCTION', constructionProjectId: minha.id, totalValue: 1000 }), tenant.userId, t);
    assert.equal(c.constructionProjectId, minha.id);
  });
});

test('varredura: NC, linha de orçamento, lançamento financeiro e local de estoque recusam obra de outra empresa', async () => {
  await H.withRollbackTenantTransaction(tenant, async (t) => {
    const obraAlheia = await inOtherCompany(tenant, t, (other) => projectsService.createProject({ groupId: tenant.groupId, companyId: other.id, name: `Obra alheia ${H.uniqueSuffix()}` }, tenant.userId, t));
    const foto = await evidenceIds(tenant, t);
    await assert.rejects(nonconformitiesService.createNonconformity(obraAlheia.id, W(tenant, { description: 'x', responsibleUserId: tenant.userId, beforeEvidenceFileIds: foto }), tenant.userId, t), REF);
    await assert.rejects(budgetLinesService.createBudgetLine(obraAlheia.id, W(tenant, { category: 'X', plannedAmount: 10 }), tenant.userId, t), REF);
    const cc = await H.createTestCostCenter(tenant, t);
    await assert.rejects(
      financialEntriesService.createFinancialEntry(W(tenant, { entryType: 'DEBIT', nature: 'PAYABLE', amount: 10, costCenterId: cc.id, constructionProjectId: obraAlheia.id }), tenant.userId, t),
      REF
    );
    await assert.rejects(itemsService.createLocation(W(tenant, { name: `Canteiro ${H.uniqueSuffix()}`, locationType: 'PROJECT_SITE', projectId: obraAlheia.id }), tenant.userId, t), REF);
    assert.equal(await InventoryLocation.count({ where: { projectId: obraAlheia.id }, transaction: t }), 0);
  });
});

test('varredura: etapa de outra obra, responsável/aceite fora da empresa e quem abriu o chamado de outra empresa são recusados', async () => {
  await H.withRollbackTenantTransaction(tenant, async (t) => {
    const obraA = await novaObra(t);
    const obraB = await novaObra(t);
    const etapaB = await projectStagesService.createProjectStage(obraB.id, W(tenant, { name: 'B1' }), tenant.userId, t);
    const foto = await evidenceIds(tenant, t);
    await assert.rejects(nonconformitiesService.createNonconformity(obraA.id, W(tenant, { projectStageId: etapaB.id, description: 'x', responsibleUserId: tenant.userId, beforeEvidenceFileIds: foto }), tenant.userId, t), REF);
    const estranho = await inOtherCompany(tenant, t, (other) => createMember(tenant, t, { companyId: other.id }));
    await assert.rejects(nonconformitiesService.createNonconformity(obraA.id, W(tenant, { description: 'x', responsibleUserId: estranho.id, beforeEvidenceFileIds: foto }), tenant.userId, t), REF);
    const pessoaAlheia = await inOtherCompany(tenant, t, (other) => Person.create({ groupId: tenant.groupId, companyId: other.id, personType: 'PF', legalName: `Alheia ${H.uniqueSuffix()}`, status: 'ACTIVE' }, { transaction: t }));
    const imovel = await propertiesService.createProperty(W(tenant, { title: `Imóvel ${H.uniqueSuffix()}`, internalCode: `M6V-${H.uniqueSuffix()}`, propertyType: 'RESIDENTIAL' }), tenant.userId, t);
    await assert.rejects(
      maintenanceCasesService.createMaintenanceCase(W(tenant, { propertyId: imovel.id, description: 'Infiltração', severity: 'HIGH', openedByPersonId: pessoaAlheia.id, beforeMediaFileIds: foto }), tenant.userId, t),
      REF
    );
    await assert.rejects(
      maintenanceCasesService.createMaintenanceCase(W(tenant, { propertyId: imovel.id, description: 'Infiltração', severity: 'HIGH', responsibleUserId: estranho.id, beforeMediaFileIds: foto }), tenant.userId, t),
      REF
    );
  });
});
