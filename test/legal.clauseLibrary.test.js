'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const contractClausesService = require('../src/features/legal/contractClauses.service');
const contractTemplatesService = require('../src/features/legal/contractTemplates.service');
const AppError = require('../src/utils/AppError');

let tenant;

before(async () => {
  tenant = await getSeedTenant();
});

after(async () => {
  await sequelize.close();
});

// AUD-012 (auditoria externa Nayara, 11/10/2026, JUR-002 "Biblioteca de cláusulas versionadas
// com responsável"): o service já existia (createClause/createClauseVersion/listClauses), mas
// não tinha NENHUMA rota HTTP — confirmado só agora com a biblioteca realmente alcançável.
// Este teste cobre o que a rota faz: criar cláusula v1, versionar, e usar a versão específica
// num template (addClauseToTemplate exige um contractClauseId existente).
test('JUR-002: biblioteca de cláusulas — criar v1, criar v2 (append-only), v1 preservada e desativada', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const code = `CLA-${uniqueSuffix()}`;
    const v1 = await contractClausesService.createClause(
      { groupId: tenant.groupId, companyId: tenant.companyId, code, title: 'Cláusula de rescisão', bodyText: 'Texto v1', category: 'TERMINATION' },
      tenant.userId,
      transaction
    );
    assert.equal(v1.versionNumber, 1);
    assert.equal(v1.isActive, true);
    assert.equal(v1.createdBy, tenant.userId, 'responsável (createdBy) registrado na criação');

    const v2 = await contractClausesService.createClauseVersion(code, { bodyText: 'Texto v2, revisado' }, tenant.userId, transaction);
    assert.equal(v2.versionNumber, 2);
    assert.equal(v2.id !== v1.id, true, 'nova versão é uma linha nova, não sobrescreve a anterior');

    const versions = await contractClausesService.listClauseVersions(code, transaction);
    assert.equal(versions.length, 2, 'as duas versões continuam existindo — append-only');
    const v1Reloaded = versions.find((v) => v.id === v1.id);
    assert.equal(v1Reloaded.bodyText, 'Texto v1', 'texto da v1 nunca foi alterado');

    const active = await contractClausesService.listClauses(transaction, { category: 'TERMINATION' });
    assert.ok(active.some((c) => c.id === v2.id && c.isActive === true));

    await contractClausesService.deactivateClause(v1.id, tenant.userId, transaction);
    const afterDeactivate = await contractClausesService.listClauseVersions(code, transaction);
    const v1AfterDeactivate = afterDeactivate.find((v) => v.id === v1.id);
    assert.equal(v1AfterDeactivate.isActive, false);
    assert.equal(v1AfterDeactivate.bodyText, 'Texto v1', 'desativar não apaga nem edita o texto');
  });
});

test('JUR-002: não é possível criar cláusula com código duplicado — tem que versionar', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const code = `CLA-${uniqueSuffix()}`;
    await contractClausesService.createClause(
      { groupId: tenant.groupId, companyId: tenant.companyId, code, title: 'X', bodyText: 'Texto', category: 'GENERAL' },
      tenant.userId,
      transaction
    );
    await assert.rejects(
      () =>
        contractClausesService.createClause(
          { groupId: tenant.groupId, companyId: tenant.companyId, code, title: 'X2', bodyText: 'Outro texto', category: 'GENERAL' },
          tenant.userId,
          transaction
        ),
      (err) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'LEGAL_CONTRACT_CLAUSE_DUPLICATE_CODE');
        return true;
      }
    );
  });
});

test('JUR-002: template só aceita vincular uma VERSÃO de cláusula que já existe', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const code = `CLA-${uniqueSuffix()}`;
    const clause = await contractClausesService.createClause(
      { groupId: tenant.groupId, companyId: tenant.companyId, code, title: 'Garantia', bodyText: 'Texto da garantia', category: 'GUARANTEE' },
      tenant.userId,
      transaction
    );
    const template = await contractTemplatesService.createTemplate(
      { groupId: tenant.groupId, companyId: tenant.companyId, contractType: 'LEASE', name: `Template ${uniqueSuffix()}` },
      tenant.userId,
      transaction
    );
    const link = await contractTemplatesService.addClauseToTemplate(template.id, { contractClauseId: clause.id }, tenant.userId, transaction);
    assert.equal(link.contractClauseId, clause.id);

    await assert.rejects(
      () => contractTemplatesService.addClauseToTemplate(template.id, { contractClauseId: '00000000-0000-0000-0000-000000000000' }, tenant.userId, transaction),
      (err) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'LEGAL_CONTRACT_CLAUSE_NOT_FOUND');
        return true;
      }
    );
  });
});
