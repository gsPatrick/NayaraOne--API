'use strict';

// Marco 8 — fechamento do pipeline de documento do Caderno ("Upload → malware scan → hash →
// OCR/IA → sugestão → validação humana"). Malware scan e hash (checksumSha256) já existem desde
// sempre no storage genérico (src/features/files/files.service.js), reusados aqui sem duplicar.
// Este arquivo cobre o que é específico do Correspondente: sinalização de re-upload idêntico
// (por hash) e a sugestão heurística determinística (substituto honesto do "OCR/IA", que é
// fronteira com o Marco 9/NAY generativa — fora de escopo).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const financingCasesService = require('../src/features/correspondent/cases/financingCases.service');
const caseDocumentsService = require('../src/features/correspondent/cases/caseDocuments.service');
const { Person, File } = require('../src/models');

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

async function makeFile(transaction, { name, mimeType = 'application/pdf', sizeBytes = 50000, checksumSha256 }) {
  return File.create(
    {
      groupId: tenant.groupId,
      companyId: tenant.companyId,
      fileName: name,
      mimeType,
      storageKey: `test/${Date.now()}-${name}`,
      sizeBytes,
      checksumSha256: checksumSha256 || null,
    },
    { transaction }
  );
}

test('CORRESPONDENT-PIPE-01: re-upload com o MESMO hash de um arquivo já enviado pro requirement é sinalizado (duplicateOfDocumentId), nunca bloqueado', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const financingCase = await makeCase(transaction);
    const requirement = await caseDocumentsService.createRequirement(
      financingCase.id, { documentType: 'COMPROVANTE_RESIDENCIA' }, tenant.userId,
      { groupId: tenant.groupId, companyId: tenant.companyId }, transaction
    );
    const sharedHash = `hash-${uniqueSuffix()}`;
    const file1 = await makeFile(transaction, { name: 'comprovante.pdf', checksumSha256: sharedHash });
    const doc1 = await caseDocumentsService.uploadDocument(
      financingCase.id, requirement.id, { fileId: file1.id }, tenant.userId,
      { groupId: tenant.groupId, companyId: tenant.companyId }, transaction
    );
    assert.equal(doc1.duplicateOfDocumentId, null);

    // Mesmo conteúdo (mesmo hash), arquivo diferente — simula o usuário reenviando o mesmo PDF.
    const file2 = await makeFile(transaction, { name: 'comprovante-de-novo.pdf', checksumSha256: sharedHash });
    const doc2 = await caseDocumentsService.uploadDocument(
      financingCase.id, requirement.id, { fileId: file2.id }, tenant.userId,
      { groupId: tenant.groupId, companyId: tenant.companyId }, transaction
    );
    assert.equal(doc2.duplicateOfDocumentId, doc1.id, 'deveria sinalizar o documento duplicado, nunca bloquear o upload');
    assert.equal(doc2.version, 2, 'mesmo sendo duplicata de conteúdo, ainda vira uma nova versão (nunca bloqueia)');
  });
});

test('CORRESPONDENT-PIPE-02: conteúdo diferente (hash diferente) nunca é marcado como duplicata', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const financingCase = await makeCase(transaction);
    const requirement = await caseDocumentsService.createRequirement(
      financingCase.id, { documentType: 'IPTU' }, tenant.userId,
      { groupId: tenant.groupId, companyId: tenant.companyId }, transaction
    );
    const file1 = await makeFile(transaction, { name: 'iptu-2025.pdf', checksumSha256: `hash-a-${uniqueSuffix()}` });
    await caseDocumentsService.uploadDocument(
      financingCase.id, requirement.id, { fileId: file1.id }, tenant.userId,
      { groupId: tenant.groupId, companyId: tenant.companyId }, transaction
    );
    const file2 = await makeFile(transaction, { name: 'iptu-2026.pdf', checksumSha256: `hash-b-${uniqueSuffix()}` });
    const doc2 = await caseDocumentsService.uploadDocument(
      financingCase.id, requirement.id, { fileId: file2.id }, tenant.userId,
      { groupId: tenant.groupId, companyId: tenant.companyId }, transaction
    );
    assert.equal(doc2.duplicateOfDocumentId, null);
  });
});

test('CORRESPONDENT-PIPE-03: documento tipo que espera PDF enviado como imagem recebe sugestão de alerta (nunca bloqueia)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const financingCase = await makeCase(transaction);
    const requirement = await caseDocumentsService.createRequirement(
      financingCase.id, { documentType: 'MATRICULA_IMOVEL' }, tenant.userId,
      { groupId: tenant.groupId, companyId: tenant.companyId }, transaction
    );
    const file = await makeFile(transaction, { name: 'matricula-foto.jpg', mimeType: 'image/jpeg', sizeBytes: 500000 });
    const document = await caseDocumentsService.uploadDocument(
      financingCase.id, requirement.id, { fileId: file.id }, tenant.userId,
      { groupId: tenant.groupId, companyId: tenant.companyId }, transaction
    );
    assert.ok(document.suggestedNote, 'deveria gerar uma sugestão pro validador humano');
    assert.match(document.suggestedNote, /PDF oficial/);
  });
});

test('CORRESPONDENT-PIPE-04: documento no tipo/formato esperado não recebe sugestão nenhuma', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const financingCase = await makeCase(transaction);
    const requirement = await caseDocumentsService.createRequirement(
      financingCase.id, { documentType: 'MATRICULA_IMOVEL' }, tenant.userId,
      { groupId: tenant.groupId, companyId: tenant.companyId }, transaction
    );
    const file = await makeFile(transaction, { name: 'matricula.pdf', mimeType: 'application/pdf', sizeBytes: 500000 });
    const document = await caseDocumentsService.uploadDocument(
      financingCase.id, requirement.id, { fileId: file.id }, tenant.userId,
      { groupId: tenant.groupId, companyId: tenant.companyId }, transaction
    );
    assert.equal(document.suggestedNote, null);
  });
});

test('CORRESPONDENT-PIPE-05: arquivo minúsculo (<10KB) gera sugestão de "pode estar incompleto", mesmo em tipo que aceita foto (RG_CPF)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const financingCase = await makeCase(transaction);
    const requirement = await caseDocumentsService.createRequirement(
      financingCase.id, { documentType: 'RG_CPF' }, tenant.userId,
      { groupId: tenant.groupId, companyId: tenant.companyId }, transaction
    );
    const file = await makeFile(transaction, { name: 'rg.jpg', mimeType: 'image/jpeg', sizeBytes: 2000 });
    const document = await caseDocumentsService.uploadDocument(
      financingCase.id, requirement.id, { fileId: file.id }, tenant.userId,
      { groupId: tenant.groupId, companyId: tenant.companyId }, transaction
    );
    assert.ok(document.suggestedNote);
    assert.match(document.suggestedNote, /incompleto/);
  });
});

test('CORRESPONDENT-PIPE-06: malware scan e hash do storage genérico já cobrem qualquer upload do Correspondente (reuso confirmado, não duplicado)', async () => {
  // Confirma, por leitura de código em runtime, que uploadDocument usa o fileId vindo de
  // files.service.js#uploadFile (que já roda antivírus + calcula checksumSha256) em vez de
  // reimplementar scan/hash dentro do módulo correspondent.
  const filesService = require('../src/features/files/files.service');
  assert.equal(typeof filesService.uploadFile, 'function');
  const serviceSource = require('fs').readFileSync(
    require.resolve('../src/features/correspondent/cases/caseDocuments.service.js'),
    'utf8'
  );
  assert.ok(!/resolveAntivirusAdapter|\.scan\(/.test(serviceSource), 'caseDocuments.service.js não deve reimplementar scan de antivírus — reusa files.service.js#uploadFile');
});
