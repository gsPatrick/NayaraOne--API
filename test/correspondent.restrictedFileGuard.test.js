'use strict';

/**
 * Marco 8 — auditoria pós-DoD, Frente RLS, Ciclo 4. Achado real: o download/metadado genérico
 * de arquivo (`GET /files/:id` e `GET /files/:id/content`) não checava a permissão dedicada
 * `correspondent:documents:read` — qualquer usuário autenticado do tenant conseguia baixar o
 * conteúdo de um documento RESTRICTED (ex.: comprovante de renda) sabendo/adivinhando o fileId,
 * mesmo sem a permissão, porque o filtro só existia na listagem do checklist. Corrigido com
 * `assertNotRestrictedFile` em `files.controller.js`, chamado antes de servir metadado OU
 * conteúdo de QUALQUER arquivo.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const financingCasesService = require('../src/features/correspondent/cases/financingCases.service');
const caseDocumentsService = require('../src/features/correspondent/cases/caseDocuments.service');
const { assertNotRestrictedFile } = require('../src/features/files/files.controller');
const { Person, File } = require('../src/models');
const AppError = require('../src/utils/AppError');

let tenant;

before(async () => {
  tenant = await getSeedTenant();
});

after(async () => {
  await sequelize.close();
});

async function makeCase(transaction) {
  const principal = await Person.create(
    { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `Proponente ${uniqueSuffix()}`, createdBy: tenant.userId, updatedBy: tenant.userId },
    { transaction }
  );
  return financingCasesService.createFinancingCase(
    { groupId: tenant.groupId, companyId: tenant.companyId, applicants: [{ personId: principal.id, role: 'PRINCIPAL' }] },
    tenant.userId,
    transaction
  );
}

async function makeFile(transaction, name) {
  return File.create(
    { groupId: tenant.groupId, companyId: tenant.companyId, fileName: name, mimeType: 'application/pdf', storageKey: `test/${Date.now()}-${name}`, sizeBytes: 10 },
    { transaction }
  );
}

test('CORRESPONDENT-FILEGUARD-01: usuário sem correspondent:documents:read não baixa documento RESTRICTED pelo fileId direto', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const financingCase = await makeCase(transaction);
    const requirement = await caseDocumentsService.createRequirement(financingCase.id, { documentType: 'COMPROVANTE_RENDA' }, tenant.userId, { groupId: tenant.groupId, companyId: tenant.companyId }, transaction);
    const file = await makeFile(transaction, `renda-${uniqueSuffix()}.pdf`);
    await caseDocumentsService.uploadDocument(financingCase.id, requirement.id, { fileId: file.id }, tenant.userId, { groupId: tenant.groupId, companyId: tenant.companyId }, transaction);

    await assert.rejects(
      () => assertNotRestrictedFile(file.id, [], transaction),
      (err) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'FILE_RESTRICTED_DOCUMENT');
        assert.equal(err.statusCode, 403);
        return true;
      }
    );
  });
});

test('CORRESPONDENT-FILEGUARD-02: usuário com correspondent:documents:read passa pela guarda', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const financingCase = await makeCase(transaction);
    const requirement = await caseDocumentsService.createRequirement(financingCase.id, { documentType: 'COMPROVANTE_RENDA' }, tenant.userId, { groupId: tenant.groupId, companyId: tenant.companyId }, transaction);
    const file = await makeFile(transaction, `renda-${uniqueSuffix()}.pdf`);
    await caseDocumentsService.uploadDocument(financingCase.id, requirement.id, { fileId: file.id }, tenant.userId, { groupId: tenant.groupId, companyId: tenant.companyId }, transaction);

    await assert.doesNotReject(() => assertNotRestrictedFile(file.id, ['correspondent:documents:read'], transaction));
  });
});

test('CORRESPONDENT-FILEGUARD-03: arquivo não vinculado a nenhum CaseDocument RESTRICTED passa livre (não quebra outros módulos)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const file = await makeFile(transaction, `laudo-vistoria-${uniqueSuffix()}.pdf`);
    await assert.doesNotReject(() => assertNotRestrictedFile(file.id, [], transaction));
  });
});
