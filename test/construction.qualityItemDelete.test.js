'use strict';

// M6-??: teste dedicado da rota DELETE /construction/quality-items/:id (criada no Ciclo 9 da
// auditoria contínua do Marco 6 — removeQualityItem em qualityChecklist.service.js). Cobre:
// (1) exclusão com sucesso enquanto o item ainda está PENDING; (2) bloqueio de exclusão depois
// que o item já foi verificado (OK/NOT_OK) — o registro passa a ter valor de
// auditoria/histórico; (3) bloqueio de escrita cross-tenant via RLS no nível do banco,
// contornando a camada de serviço (mesmo padrão de construction.rlsWrite.test.js / M6-66).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const AppError = require('../src/utils/AppError');
const projectsService = require('../src/features/construction/projects.service');
const projectStagesService = require('../src/features/construction/projectStages.service');
const qualityChecklistService = require('../src/features/construction/qualityChecklist.service');
const { QualityChecklistItem } = require('../src/models');

let tenant;
let otherCompanyId;

before(async () => {
  tenant = await getSeedTenant();
  const [[row]] = await sequelize.query(
    'SELECT id FROM core.companies WHERE id != :companyId LIMIT 1',
    { replacements: { companyId: tenant.companyId } }
  );
  otherCompanyId = row ? row.id : '00000000-0000-0000-0000-000000000000';
});

after(async () => {
  await sequelize.close();
});

function withTenant(fields) {
  return { groupId: tenant.groupId, companyId: tenant.companyId, ...fields };
}

test('DELETE quality-items: remove com sucesso item ainda PENDING', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const project = await projectsService.createProject(
      withTenant({ name: `HOMO QA Obra QualityDelete ${uniqueSuffix()}` }),
      tenant.userId,
      transaction
    );
    const item = await qualityChecklistService.createQualityItem(
      project.id,
      withTenant({ item: 'Verificar prumo', category: 'ESTRUTURA' }),
      tenant.userId,
      transaction
    );
    assert.equal(item.status, 'PENDING');

    const result = await qualityChecklistService.removeQualityItem(item.id, tenant.userId, transaction);
    assert.equal(result.id, item.id);

    const reloaded = await QualityChecklistItem.findByPk(item.id, { transaction });
    assert.equal(reloaded, null, 'item deve ter sido removido de fato do banco');
  });
});

// BUG REAL CORRIGIDO ("ciclos até secar", Ciclo 10, Frente B, 09/10/2026): createQualityItem
// nunca comparava a ProjectStage referenciada com o projectId do contexto — um item de
// checklist da Obra A podia referenciar uma etapa pertencente à Obra B.
test('createQualityItem recusa projectStageId que pertence a outra obra', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const projectA = await projectsService.createProject(withTenant({ name: `HOMO QA Obra A cross-stage ${uniqueSuffix()}` }), tenant.userId, transaction);
    const projectB = await projectsService.createProject(withTenant({ name: `HOMO QA Obra B cross-stage ${uniqueSuffix()}` }), tenant.userId, transaction);
    const stageOfB = await projectStagesService.createProjectStage(projectB.id, withTenant({ name: 'Etapa de B' }), tenant.userId, transaction);

    await assert.rejects(
      () => qualityChecklistService.createQualityItem(projectA.id, withTenant({ item: 'Verificar prumo', projectStageId: stageOfB.id }), tenant.userId, transaction),
      (err) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'QUALITY_ITEM_STAGE_PROJECT_MISMATCH');
        return true;
      }
    );
  });
});

test('DELETE quality-items: bloqueia exclusão de item já verificado (OK/NOT_OK)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const project = await projectsService.createProject(
      withTenant({ name: `HOMO QA Obra QualityDelete2 ${uniqueSuffix()}` }),
      tenant.userId,
      transaction
    );
    const item = await qualityChecklistService.createQualityItem(
      project.id,
      withTenant({ item: 'Verificar vedação', category: 'HIDRAULICA' }),
      tenant.userId,
      transaction
    );
    await qualityChecklistService.checkQualityItem(item.id, { status: 'OK' }, tenant.userId, transaction);

    await assert.rejects(
      () => qualityChecklistService.removeQualityItem(item.id, tenant.userId, transaction),
      (err) => {
        assert.equal(err.code, 'QUALITY_ITEM_NOT_DELETABLE');
        return true;
      }
    );

    const stillThere = await QualityChecklistItem.findByPk(item.id, { transaction });
    assert.ok(stillThere, 'item verificado não deve ter sido removido');
  });
});

test('DELETE quality-items: tentativa cross-tenant via SQL direto é bloqueada pelo RLS', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const project = await projectsService.createProject(
      withTenant({ name: `HOMO QA Obra QualityDelete3 ${uniqueSuffix()}` }),
      tenant.userId,
      transaction
    );
    const item = await qualityChecklistService.createQualityItem(
      project.id,
      withTenant({ item: 'Verificar fiação', category: 'ELETRICA' }),
      tenant.userId,
      transaction
    );

    await sequelize.query('SET LOCAL app.company_id = :otherCompanyId', {
      replacements: { otherCompanyId },
      transaction,
    });

    const [, deleteResult] = await sequelize.query(
      `DELETE FROM "construction"."quality_checklist_items" WHERE id = :itemId`,
      { replacements: { itemId: item.id }, transaction }
    );
    assert.equal(deleteResult.rowCount, 0, 'DELETE cross-tenant não deve afetar nenhuma linha (RLS bloqueia a escrita)');

    await sequelize.query('SET LOCAL app.company_id = :companyId', {
      replacements: { companyId: tenant.companyId },
      transaction,
    });
    const reloaded = await QualityChecklistItem.findByPk(item.id, { transaction });
    assert.ok(reloaded, 'item original deve permanecer intacto após a tentativa de exclusão cross-tenant');
  });
});
