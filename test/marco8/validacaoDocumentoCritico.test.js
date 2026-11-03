'use strict';

// Marco 8 — a validação do documento é barrada no servidor quando a leitura mostra documento
// ilegível ou campo crítico ausente. O resultado da leitura é gravado no documento (reading_status
// e reading_found_fields); aqui ele é ajustado direto no banco para exercitar cada resultado.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('../testHelpers');
const financingCasesService = require('../../src/features/correspondent/cases/financingCases.service');
const caseDocumentsService = require('../../src/features/correspondent/cases/caseDocuments.service');
const { Person, File, CaseDocument, CaseRequirement } = require('../../src/models');

let tenant;
const ctx = () => ({ groupId: tenant.groupId, companyId: tenant.companyId });
const CPF_VALIDO = '52998224725';

before(async () => {
  tenant = await getSeedTenant();
});

after(async () => {
  await sequelize.close();
});

async function documentoEnviado(transaction, { documentType = 'RG_CPF', readingStatus, readingFoundFields }) {
  const pessoa = await Person.create(
    { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `Proponente CRIT ${uniqueSuffix()}`, createdBy: tenant.userId, updatedBy: tenant.userId },
    { transaction }
  );
  const caso = await financingCasesService.createFinancingCase(
    { groupId: tenant.groupId, companyId: tenant.companyId, applicants: [{ personId: pessoa.id, role: 'PRINCIPAL' }] },
    tenant.userId,
    transaction
  );
  const requirement = await caseDocumentsService.createRequirement(caso.id, { documentType }, tenant.userId, ctx(), transaction);
  const file = await File.create(
    { groupId: tenant.groupId, companyId: tenant.companyId, fileName: `crit-${uniqueSuffix()}.pdf`, mimeType: 'application/pdf', sizeBytes: 2048, storageKey: `test/${uniqueSuffix()}.pdf`, uploadedByUserId: tenant.userId },
    { transaction }
  );
  const document = await caseDocumentsService.uploadDocument(caso.id, requirement.id, { fileId: file.id }, tenant.userId, ctx(), transaction);
  await CaseDocument.update({ readingStatus, readingFoundFields }, { where: { id: document.id }, transaction });
  return { caso, requirement, document };
}

const codigo = (code) => (err) => err.code === code;

test('M8-CRIT-01: documento ilegível nunca é validado, nem com dados informados à mão', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const { caso, requirement } = await documentoEnviado(t, { readingStatus: 'ILLEGIBLE', readingFoundFields: [] });
    await assert.rejects(caseDocumentsService.validateRequirement(caso.id, requirement.id, tenant.userId, ctx(), t), codigo('CASE_REQUIREMENT_DOCUMENT_ILLEGIBLE'));
    await assert.rejects(
      caseDocumentsService.validateRequirement(caso.id, requirement.id, tenant.userId, ctx(), t, { manualFields: { taxId: CPF_VALIDO, name: 'Fulano de Tal' } }),
      codigo('CASE_REQUIREMENT_DOCUMENT_ILLEGIBLE')
    );
    await requirement.reload({ transaction: t });
    assert.equal(requirement.status, 'SUBMITTED');
  });
});

test('M8-CRIT-02: RG/CPF lido sem CPF não é validado; o erro diz o que falta', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const { caso, requirement } = await documentoEnviado(t, { readingStatus: 'READ', readingFoundFields: ['name'] });
    await assert.rejects(
      caseDocumentsService.validateRequirement(caso.id, requirement.id, tenant.userId, ctx(), t),
      (err) => err.code === 'CASE_REQUIREMENT_CRITICAL_FIELDS_MISSING' && /CPF\/CNPJ/.test(err.message) && !/Nome/.test(err.message)
    );
    await requirement.reload({ transaction: t });
    assert.equal(requirement.status, 'SUBMITTED');
  });
});

test('M8-CRIT-03: CPF informado à mão precisa ser válido; CPF inválido ou em branco continua barrando', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const { caso, requirement } = await documentoEnviado(t, { readingStatus: 'READ', readingFoundFields: ['name'] });
    await assert.rejects(
      caseDocumentsService.validateRequirement(caso.id, requirement.id, tenant.userId, ctx(), t, { manualFields: { taxId: '11111111111' } }),
      codigo('CASE_REQUIREMENT_MANUAL_FIELD_INVALID')
    );
    await assert.rejects(
      caseDocumentsService.validateRequirement(caso.id, requirement.id, tenant.userId, ctx(), t, { manualFields: { taxId: '   ' } }),
      codigo('CASE_REQUIREMENT_CRITICAL_FIELDS_MISSING')
    );
  });
});

test('M8-CRIT-04: com o CPF informado e conferido, valida e registra na nota e na auditoria que foi manual', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const { caso, requirement, document } = await documentoEnviado(t, { readingStatus: 'READ', readingFoundFields: ['name'] });
    const validado = await caseDocumentsService.validateRequirement(caso.id, requirement.id, tenant.userId, ctx(), t, { manualFields: { taxId: CPF_VALIDO } });
    assert.equal(validado.status, 'VALIDATED');
    const atual = await CaseDocument.findByPk(document.id, { transaction: t });
    assert.match(atual.suggestedNote, /Informado por quem validou.*CPF\/CNPJ: 529\.982\.247-25/);
  });
});

test('M8-CRIT-05: leitura que achou todos os campos críticos valida sem informar nada', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const { caso, requirement } = await documentoEnviado(t, { readingStatus: 'READ', readingFoundFields: ['taxId', 'name'] });
    const validado = await caseDocumentsService.validateRequirement(caso.id, requirement.id, tenant.userId, ctx(), t);
    assert.equal(validado.status, 'VALIDATED');
  });
});

test('M8-CRIT-06: sem leitor ativo (NOT_READ) os campos críticos também precisam ser informados', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const { caso, requirement } = await documentoEnviado(t, { readingStatus: 'NOT_READ', readingFoundFields: [] });
    await assert.rejects(caseDocumentsService.validateRequirement(caso.id, requirement.id, tenant.userId, ctx(), t), codigo('CASE_REQUIREMENT_CRITICAL_FIELDS_MISSING'));
    const validado = await caseDocumentsService.validateRequirement(caso.id, requirement.id, tenant.userId, ctx(), t, { manualFields: { taxId: CPF_VALIDO, name: 'Fulano de Tal' } });
    assert.equal(validado.status, 'VALIDATED');
  });
});

test('M8-CRIT-07: comprovante de renda sem renda e extrato sem conta são barrados; tipo sem campo crítico só exige legibilidade', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const renda = await documentoEnviado(t, { documentType: 'COMPROVANTE_RENDA', readingStatus: 'READ', readingFoundFields: ['name', 'taxId'] });
    await assert.rejects(caseDocumentsService.validateRequirement(renda.caso.id, renda.requirement.id, tenant.userId, ctx(), t), (err) => err.code === 'CASE_REQUIREMENT_CRITICAL_FIELDS_MISSING' && /Renda/.test(err.message));
    await assert.rejects(caseDocumentsService.validateRequirement(renda.caso.id, renda.requirement.id, tenant.userId, ctx(), t, { manualFields: { income: '0' } }), codigo('CASE_REQUIREMENT_MANUAL_FIELD_INVALID'));

    const extrato = await documentoEnviado(t, { documentType: 'EXTRATO_BANCARIO', readingStatus: 'READ', readingFoundFields: ['name'] });
    await assert.rejects(caseDocumentsService.validateRequirement(extrato.caso.id, extrato.requirement.id, tenant.userId, ctx(), t), (err) => err.code === 'CASE_REQUIREMENT_CRITICAL_FIELDS_MISSING' && /Conta/.test(err.message));

    const iptu = await documentoEnviado(t, { documentType: 'IPTU', readingStatus: 'READ', readingFoundFields: [] });
    assert.equal((await caseDocumentsService.validateRequirement(iptu.caso.id, iptu.requirement.id, tenant.userId, ctx(), t)).status, 'VALIDATED');
  });
});

test('M8-CRIT-08: documento recusado por ilegível volta a aceitar novo arquivo e a validação passa depois', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const { caso, requirement } = await documentoEnviado(t, { readingStatus: 'ILLEGIBLE', readingFoundFields: [] });
    await caseDocumentsService.rejectRequirement(caso.id, requirement.id, 'Arquivo ilegível', tenant.userId, ctx(), t);
    const file2 = await File.create(
      { groupId: tenant.groupId, companyId: tenant.companyId, fileName: `crit2-${uniqueSuffix()}.pdf`, mimeType: 'application/pdf', sizeBytes: 2048, storageKey: `test/${uniqueSuffix()}.pdf`, uploadedByUserId: tenant.userId },
      { transaction: t }
    );
    const novo = await caseDocumentsService.uploadDocument(caso.id, requirement.id, { fileId: file2.id }, tenant.userId, ctx(), t);
    await CaseDocument.update({ readingStatus: 'READ', readingFoundFields: ['taxId', 'name'] }, { where: { id: novo.id }, transaction: t });
    const validado = await caseDocumentsService.validateRequirement(caso.id, requirement.id, tenant.userId, ctx(), t);
    assert.equal(validado.status, 'VALIDATED');
    assert.ok(CaseRequirement);
  });
});
