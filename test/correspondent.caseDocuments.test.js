'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const financingCasesService = require('../src/features/correspondent/cases/financingCases.service');
const caseDocumentsService = require('../src/features/correspondent/cases/caseDocuments.service');
const { Person, File } = require('../src/models');

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

async function makeFile(transaction, companyId, name) {
  return File.create(
    { groupId: tenant.groupId, companyId, fileName: name, mimeType: 'application/pdf', storageKey: `test/${Date.now()}-${name}`, sizeBytes: 10 },
    { transaction }
  );
}

test('CORRESPONDENT-DOC-01: cria requirement PENDING e lista no checklist do caso', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const financingCase = await makeCase(transaction);
    const requirement = await caseDocumentsService.createRequirement(
      financingCase.id,
      { documentType: 'RG_CPF' },
      tenant.userId,
      { groupId: tenant.groupId, companyId: tenant.companyId },
      transaction
    );
    assert.equal(requirement.status, 'PENDING');
    assert.equal(requirement.required, true);

    const list = await caseDocumentsService.listRequirements(financingCase.id, { groupId: tenant.groupId, companyId: tenant.companyId }, transaction, { canSeeDocuments: true });
    assert.equal(list.length, 1);
    assert.equal(list[0].documentType, 'RG_CPF');
  });
});

test('CORRESPONDENT-DOC-02: rejeita documentType inválido', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const financingCase = await makeCase(transaction);
    await assert.rejects(
      () => caseDocumentsService.createRequirement(financingCase.id, { documentType: 'INVALIDO' }, tenant.userId, { groupId: tenant.groupId, companyId: tenant.companyId }, transaction),
      (err) => err.code === 'CASE_REQUIREMENT_VALIDATION'
    );
  });
});

test('CORRESPONDENT-DOC-03: enviar documento marca requirement como SUBMITTED e cria versão 1', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const financingCase = await makeCase(transaction);
    const requirement = await caseDocumentsService.createRequirement(financingCase.id, { documentType: 'COMPROVANTE_RENDA' }, tenant.userId, { groupId: tenant.groupId, companyId: tenant.companyId }, transaction);
    const file = await makeFile(transaction, tenant.companyId, 'renda-v1.pdf');

    const document = await caseDocumentsService.uploadDocument(
      financingCase.id,
      requirement.id,
      { fileId: file.id },
      tenant.userId,
      { groupId: tenant.groupId, companyId: tenant.companyId },
      transaction
    );
    assert.equal(document.version, 1);
    assert.equal(document.classification, 'RESTRICTED');
    assert.equal(document.supersededAt, null);

    const [[reqRow]] = await sequelize.query('SELECT status FROM "correspondent"."case_requirements" WHERE id = :id', { replacements: { id: requirement.id }, transaction });
    assert.equal(reqRow.status, 'SUBMITTED');
  });
});

test('CORRESPONDENT-DOC-04: substituir documento preserva a versão anterior (nunca apaga/sobrescreve) e incrementa a versão', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const financingCase = await makeCase(transaction);
    const requirement = await caseDocumentsService.createRequirement(financingCase.id, { documentType: 'COMPROVANTE_RESIDENCIA' }, tenant.userId, { groupId: tenant.groupId, companyId: tenant.companyId }, transaction);
    const fileV1 = await makeFile(transaction, tenant.companyId, 'residencia-v1.pdf');
    const fileV2 = await makeFile(transaction, tenant.companyId, 'residencia-v2.pdf');

    const docV1 = await caseDocumentsService.uploadDocument(financingCase.id, requirement.id, { fileId: fileV1.id }, tenant.userId, { groupId: tenant.groupId, companyId: tenant.companyId }, transaction);
    const docV2 = await caseDocumentsService.uploadDocument(financingCase.id, requirement.id, { fileId: fileV2.id }, tenant.userId, { groupId: tenant.groupId, companyId: tenant.companyId }, transaction);

    assert.equal(docV2.version, 2);
    assert.equal(docV2.supersededAt, null);

    // Versão 1 continua existindo no banco, só marcada como superada — NUNCA apagada/sobrescrita.
    const [[v1Row]] = await sequelize.query('SELECT id, version, superseded_at FROM "correspondent"."case_documents" WHERE id = :id', { replacements: { id: docV1.id }, transaction });
    assert.ok(v1Row, 'a linha da versão 1 precisa continuar existindo');
    assert.equal(v1Row.version, 1);
    assert.ok(v1Row.superseded_at, 'versão 1 precisa estar marcada como superada');

    const [allVersions] = await sequelize.query('SELECT version FROM "correspondent"."case_documents" WHERE requirement_id = :id ORDER BY version', { replacements: { id: requirement.id }, transaction });
    assert.deepEqual(allVersions.map((r) => r.version), [1, 2]);
  });
});

test('CORRESPONDENT-DOC-05: rejeita arquivo de outra empresa', async () => {
  if (otherCompanyId === '00000000-0000-0000-0000-000000000000') return; // só roda se houver uma 2ª empresa real no banco de dev.
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const financingCase = await makeCase(transaction);
    const requirement = await caseDocumentsService.createRequirement(financingCase.id, { documentType: 'IPTU' }, tenant.userId, { groupId: tenant.groupId, companyId: tenant.companyId }, transaction);
    // Precisa trocar o contexto de RLS pra "outra empresa" antes de criar o arquivo dela — senão
    // o INSERT em core.files viola a própria policy (mesmo princípio de teste adversarial real
    // usado em legal.crossCompanyIsolation.test.js).
    await sequelize.query('SET LOCAL app.company_id = :otherCompanyId', { replacements: { otherCompanyId }, transaction });
    const foreignFile = await makeFile(transaction, otherCompanyId, 'iptu-outra-empresa.pdf');
    await sequelize.query('SET LOCAL app.company_id = :companyId', { replacements: { companyId: tenant.companyId }, transaction });

    await assert.rejects(
      () => caseDocumentsService.uploadDocument(financingCase.id, requirement.id, { fileId: foreignFile.id }, tenant.userId, { groupId: tenant.groupId, companyId: tenant.companyId }, transaction),
      (err) => err.code === 'CASE_DOCUMENT_FILE_NOT_FOUND'
    );
  });
});

test('CORRESPONDENT-DOC-06: sem canSeeDocuments, a listagem nunca inclui documents/fileId (permissão RESTRICTED)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const financingCase = await makeCase(transaction);
    const requirement = await caseDocumentsService.createRequirement(financingCase.id, { documentType: 'MATRICULA_IMOVEL' }, tenant.userId, { groupId: tenant.groupId, companyId: tenant.companyId }, transaction);
    const file = await makeFile(transaction, tenant.companyId, 'matricula.pdf');
    await caseDocumentsService.uploadDocument(financingCase.id, requirement.id, { fileId: file.id }, tenant.userId, { groupId: tenant.groupId, companyId: tenant.companyId }, transaction);

    const listWithoutPermission = await caseDocumentsService.listRequirements(financingCase.id, { groupId: tenant.groupId, companyId: tenant.companyId }, transaction, { canSeeDocuments: false });
    assert.equal(listWithoutPermission[0].documents.length, 0, 'sem a permissão dedicada, documents precisa vir vazio');

    const listWithPermission = await caseDocumentsService.listRequirements(financingCase.id, { groupId: tenant.groupId, companyId: tenant.companyId }, transaction, { canSeeDocuments: true });
    assert.equal(listWithPermission[0].documents.length, 1, 'com a permissão, o documento vigente precisa aparecer');
  });
});

test('CORRESPONDENT-DOC-07: RLS — outra empresa não enxerga requirements/documents via SELECT direto', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const financingCase = await makeCase(transaction);
    const requirement = await caseDocumentsService.createRequirement(financingCase.id, { documentType: 'CERTIDAO_ESTADO_CIVIL' }, tenant.userId, { groupId: tenant.groupId, companyId: tenant.companyId }, transaction);
    const file = await makeFile(transaction, tenant.companyId, 'certidao.pdf');
    const document = await caseDocumentsService.uploadDocument(financingCase.id, requirement.id, { fileId: file.id }, tenant.userId, { groupId: tenant.groupId, companyId: tenant.companyId }, transaction);

    await sequelize.query('SET LOCAL app.company_id = :otherCompanyId', { replacements: { otherCompanyId }, transaction });

    const [reqRows] = await sequelize.query('SELECT id FROM "correspondent"."case_requirements" WHERE id = :id', { replacements: { id: requirement.id }, transaction });
    assert.equal(reqRows.length, 0);

    const [docRows] = await sequelize.query('SELECT id FROM "correspondent"."case_documents" WHERE id = :id', { replacements: { id: document.id }, transaction });
    assert.equal(docRows.length, 0);
  });
});

test('CORRESPONDENT-DOC-08: requirementId obrigatório ao enviar documento', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const financingCase = await makeCase(transaction);
    const file = await makeFile(transaction, tenant.companyId, 'sem-requirement.pdf');
    await assert.rejects(
      () => caseDocumentsService.uploadDocument(financingCase.id, undefined, { fileId: file.id }, tenant.userId, { groupId: tenant.groupId, companyId: tenant.companyId }, transaction),
      (err) => err.code === 'CASE_DOCUMENT_VALIDATION'
    );
  });
});

test('CORRESPONDENT-DOC-09: índice único garante no máximo uma versão vigente por requirement (nível de banco)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const financingCase = await makeCase(transaction);
    const requirement = await caseDocumentsService.createRequirement(financingCase.id, { documentType: 'OUTRO' }, tenant.userId, { groupId: tenant.groupId, companyId: tenant.companyId }, transaction);
    const file = await makeFile(transaction, tenant.companyId, 'outro.pdf');
    await caseDocumentsService.uploadDocument(financingCase.id, requirement.id, { fileId: file.id }, tenant.userId, { groupId: tenant.groupId, companyId: tenant.companyId }, transaction);

    // Tenta inserir uma SEGUNDA linha "vigente" (superseded_at NULL) pro mesmo requirement direto
    // via SQL, contornando o service — o índice único parcial do banco precisa recusar.
    await assert.rejects(
      () =>
        sequelize.query(
          'INSERT INTO "correspondent"."case_documents" (id, group_id, company_id, financing_case_id, requirement_id, file_id, version, classification, created_at) VALUES (gen_random_uuid(), :groupId, :companyId, :financingCaseId, :requirementId, :fileId, 99, \'RESTRICTED\', now())',
          { replacements: { groupId: tenant.groupId, companyId: tenant.companyId, financingCaseId: financingCase.id, requirementId: requirement.id, fileId: file.id }, transaction }
        ),
      (err) => /unique|duplicate/i.test(err.message)
    );
  });
});
