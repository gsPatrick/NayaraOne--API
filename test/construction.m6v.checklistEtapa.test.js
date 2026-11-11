'use strict';

// Verificação independente do Marco 6:
//  - M6-12/M6-86 (Caderno §9 "Checklist por etapa/tipo de obra; falha abre nonconformity"): tipo de obra e checklist
//    configurado por tipo e por etapa; a obra recebe os itens do seu tipo; a reprovação abre NC com a severidade
//    configurada; aplicar de novo não duplica; tipo de outra empresa ou inativo é recusado.
//  - M6-19/M6-81 (Caderno §2 "Etapas possuem ... responsável"): a etapa tem responsável, membro ativo da empresa,
//    exigido para iniciar a etapa.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./testHelpers');
const { W, inOtherCompany, createMember, evidenceIds } = require('./constructionM6vFixture');
const { QualityChecklistItem, Nonconformity, ProjectStage } = require('../src/models');
const projectsService = require('../src/features/construction/projects.service');
const projectStagesService = require('../src/features/construction/projectStages.service');
const projectTypesService = require('../src/features/construction/projectTypes.service');
const templatesService = require('../src/features/construction/checklistTemplates.service');
const qualityService = require('../src/features/construction/qualityChecklist.service');

let tenant;
before(async () => {
  tenant = await H.getSeedTenant();
});
after(async () => {
  await H.sequelize.close();
});

async function tipoComChecklist(t, code) {
  const tipo = await projectTypesService.createProjectType(W(tenant, { code, name: `Tipo ${code}` }), tenant.userId, t);
  await templatesService.createChecklistTemplate(W(tenant, { projectTypeId: tipo.id, stageCode: 'FUND', item: 'Prumo e nível das sapatas', category: 'ESTRUTURA', failureSeverity: 'HIGH', sequence: 1 }), tenant.userId, t);
  await templatesService.createChecklistTemplate(W(tenant, { projectTypeId: tipo.id, stageCode: 'FUND', item: 'Cura do concreto', category: 'ESTRUTURA', failureSeverity: 'CRITICAL', sequence: 2 }), tenant.userId, t);
  await templatesService.createChecklistTemplate(W(tenant, { projectTypeId: tipo.id, stageCode: null, item: 'Limpeza final da obra', category: 'ACABAMENTO', failureSeverity: 'LOW', sequence: 3 }), tenant.userId, t);
  return tipo;
}

test('M6-12/M6-86: obra do tipo recebe o checklist da etapa e da obra; outro tipo não; aplicar de novo não duplica', async () => {
  await H.withRollbackTenantTransaction(tenant, async (t) => {
    const s = H.uniqueSuffix();
    const casa = await tipoComChecklist(t, `CASA${s}`.slice(0, 40));
    const reforma = await projectTypesService.createProjectType(W(tenant, { code: `REF${s}`.slice(0, 40), name: 'Reforma' }), tenant.userId, t);
    await templatesService.createChecklistTemplate(W(tenant, { projectTypeId: reforma.id, stageCode: 'FUND', item: 'Item só da reforma', category: 'OUTROS' }), tenant.userId, t);

    const obra = await projectsService.createProject(W(tenant, { name: `Casa ${s}`, projectTypeId: casa.id }), tenant.userId, t);
    const doTipo = await QualityChecklistItem.findAll({ where: { projectId: obra.id }, transaction: t });
    assert.deepEqual(doTipo.map((i) => i.item), ['Limpeza final da obra'], 'sem etapa ainda: só o item da obra');

    const fund = await projectStagesService.createProjectStage(obra.id, W(tenant, { name: 'Fundação', stageCode: 'fund', responsibleUserId: tenant.userId }), tenant.userId, t);
    await projectStagesService.createProjectStage(obra.id, W(tenant, { name: 'Pintura', stageCode: 'PINT' }), tenant.userId, t);
    const itens = await QualityChecklistItem.findAll({ where: { projectId: obra.id }, order: [['item', 'ASC']], transaction: t });
    assert.deepEqual(itens.map((i) => i.item), ['Cura do concreto', 'Limpeza final da obra', 'Prumo e nível das sapatas']);
    assert.ok(itens.filter((i) => i.item !== 'Limpeza final da obra').every((i) => i.projectStageId === fund.id && i.checklistTemplateId));
    assert.equal(itens.find((i) => i.item === 'Cura do concreto').failureSeverity, 'CRITICAL');

    assert.equal((await templatesService.applyProjectChecklist(obra.id, tenant.userId, t)).length, 0, 'idempotente');
    assert.equal(await QualityChecklistItem.count({ where: { projectId: obra.id }, transaction: t }), 3);
  });
});

test('M6-12/M6-86: falha de item do checklist abre não conformidade com a severidade configurada no modelo', async () => {
  await H.withRollbackTenantTransaction(tenant, async (t) => {
    const s = H.uniqueSuffix();
    const tipo = await tipoComChecklist(t, `T${s}`.slice(0, 40));
    const obra = await projectsService.createProject(W(tenant, { name: `Obra ${s}`, projectTypeId: tipo.id }), tenant.userId, t);
    await projectStagesService.createProjectStage(obra.id, W(tenant, { name: 'Fundação', stageCode: 'FUND' }), tenant.userId, t);
    const prumo = await QualityChecklistItem.findOne({ where: { projectId: obra.id, item: 'Prumo e nível das sapatas' }, transaction: t });
    await qualityService.checkQualityItem(prumo.id, { status: 'NOT_OK', notes: 'fora de prumo', evidenceFileIds: await evidenceIds(tenant, t) }, tenant.userId, t);
    const nc = await Nonconformity.findOne({ where: { projectId: obra.id }, transaction: t });
    assert.ok(nc, 'falha abriu NC');
    assert.equal(nc.severity, 'HIGH', 'severidade do modelo (a categoria ESTRUTURA sozinha daria CRITICAL)');
    assert.equal(nc.projectStageId, prumo.projectStageId);
  });
});

test('M6-12: tipo de obra novo em obra existente gera o checklist; tipo de outra empresa ou inativo é recusado', async () => {
  await H.withRollbackTenantTransaction(tenant, async (t) => {
    const s = H.uniqueSuffix();
    const tipo = await tipoComChecklist(t, `X${s}`.slice(0, 40));
    const obra = await projectsService.createProject(W(tenant, { name: `Obra ${s}` }), tenant.userId, t);
    await projectStagesService.createProjectStage(obra.id, W(tenant, { name: 'Fundação', stageCode: 'FUND' }), tenant.userId, t);
    assert.equal(await QualityChecklistItem.count({ where: { projectId: obra.id }, transaction: t }), 0);
    await projectsService.updateProject(obra.id, { projectTypeId: tipo.id }, tenant.userId, t);
    assert.equal(await QualityChecklistItem.count({ where: { projectId: obra.id }, transaction: t }), 3);

    const alheio = await inOtherCompany(tenant, t, (other) => projectTypesService.createProjectType({ groupId: tenant.groupId, companyId: other.id, code: `AL${s}`.slice(0, 40), name: 'Alheio' }, tenant.userId, t));
    await assert.rejects(projectsService.createProject(W(tenant, { name: 'x', projectTypeId: alheio.id }), tenant.userId, t), { code: 'CONSTRUCTION_REFERENCE_NOT_IN_COMPANY' });
    await projectTypesService.updateProjectType(tipo.id, { active: false }, tenant.userId, t);
    await assert.rejects(projectsService.createProject(W(tenant, { name: 'y', projectTypeId: tipo.id }), tenant.userId, t), { code: 'PROJECT_TYPE_INACTIVE' });
    await assert.rejects(projectTypesService.createProjectType(W(tenant, { code: `x${s}`.slice(0, 40).toUpperCase(), name: 'dup' }), tenant.userId, t).then(() => projectTypesService.createProjectType(W(tenant, { code: `x${s}`.slice(0, 40), name: 'dup' }), tenant.userId, t)), { code: 'PROJECT_TYPE_CODE_DUPLICATE' });
    await assert.rejects(templatesService.createChecklistTemplate(W(tenant, { item: 'x', failureSeverity: 'GRAVE' }), tenant.userId, t), { code: 'CHECKLIST_TEMPLATE_VALIDATION' });
  });
});

test('M6-19/M6-81: etapa guarda o responsável (membro ativo da empresa) e não inicia sem ele', async () => {
  await H.withRollbackTenantTransaction(tenant, async (t) => {
    const obra = await projectsService.createProject(W(tenant, { name: `Obra ${H.uniqueSuffix()}` }), tenant.userId, t);
    const base = { stageCode: 'E1', plannedCost: 1000, startsAt: '2026-11-01', endsAt: '2026-11-30' };
    const etapa = await projectStagesService.createProjectStage(obra.id, W(tenant, { name: 'Etapa sem responsável', ...base }), tenant.userId, t);
    await assert.rejects(projectStagesService.updateProjectStage(etapa.id, { status: 'IN_PROGRESS' }, tenant.userId, t), (err) => err.code === 'PROJECT_STAGE_MISSING_REQUIRED_FIELDS' && /responsável/.test(err.message));

    const estranho = await inOtherCompany(tenant, t, (other) => createMember(tenant, t, { companyId: other.id }));
    await assert.rejects(projectStagesService.updateProjectStage(etapa.id, { responsibleUserId: estranho.id }, tenant.userId, t), { code: 'CONSTRUCTION_REFERENCE_NOT_IN_COMPANY' });
    const inativo = await createMember(tenant, t, { status: 'INACTIVE' });
    await assert.rejects(projectStagesService.createProjectStage(obra.id, W(tenant, { name: 'x', responsibleUserId: inativo.id }), tenant.userId, t), { code: 'CONSTRUCTION_REFERENCE_NOT_IN_COMPANY' });

    const membro = await createMember(tenant, t);
    await projectStagesService.updateProjectStage(etapa.id, { responsibleUserId: membro.id }, tenant.userId, t);
    const iniciada = await projectStagesService.updateProjectStage(etapa.id, { status: 'IN_PROGRESS' }, tenant.userId, t);
    assert.equal(iniciada.status, 'IN_PROGRESS');
    assert.equal((await ProjectStage.findByPk(etapa.id, { transaction: t })).responsibleUserId, membro.id);
  });
});
