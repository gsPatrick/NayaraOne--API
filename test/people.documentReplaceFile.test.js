'use strict';

/**
 * Auditoria da cliente, Marco 3 (achado 1): trocar o arquivo de um documento VERIFIED mantinha
 * versao, validacao e leitura do arquivo anterior. A troca agora preserva o original e cria uma
 * NOVA VERSAO PENDENTE, com leitura e confirmacao ligadas ao novo arquivo.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const personService = require('../src/features/people/person.service');
const personDocuments = require('../src/features/people/personDocuments.service');
const { ingestPersonDocument } = require('../src/features/people/documentIngestion.service');
const { PersonDocument, AuditLog } = require('../src/models');

let tenant;
const CPF = '52998224725';
before(async () => { tenant = await getSeedTenant(); });
after(async () => { await sequelize.close(); });

const codigo = (code) => (err) => err.code === code;
const b64 = (fields) => Buffer.from(JSON.stringify({ __mockOcr: { fields, confidence: 0.95 } }), 'utf8').toString('base64');

async function pessoaComVerificado(t) {
  const person = await personService.createPerson(
    { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `Troca arquivo ${uniqueSuffix()}` },
    tenant.userId,
    t
  );
  const base = { groupId: tenant.groupId, companyId: tenant.companyId, personId: person.id, mimeType: 'application/pdf', documentType: 'IR' };
  const fieldsA = { name: 'Fulano de Tal', taxId: CPF, income: 5000 };
  const a = await ingestPersonDocument({ ...base, fileName: 'a.pdf', contentBase64: b64(fieldsA) }, tenant.userId, t);
  const verificado = await personDocuments.updateDocument(person.id, a.personDocument.id, { verificationStatus: 'VERIFIED' }, tenant.userId, t);
  const fieldsB = { name: 'Beltrano da Silva', taxId: CPF, income: 9000 };
  const b = await ingestPersonDocument({ ...base, fileName: 'b.pdf', contentBase64: b64(fieldsB) }, tenant.userId, t);
  // b criou outra versao do mesmo tipo; usamos so o arquivo dela como "arquivo novo".
  return { person, original: verificado, novoFile: b.file, fieldsB };
}

test('NEGATIVO: trocar o fileId de documento VERIFIED nao altera o original (arquivo, versao, validacao e leitura continuam)', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const { person, original, novoFile } = await pessoaComVerificado(t);
    const fileAntigo = original.fileId;
    const leituraAntiga = JSON.stringify(original.extractedDataJson);
    await personDocuments.updateDocument(person.id, original.id, { fileId: novoFile.id }, tenant.userId, t);
    const depois = await PersonDocument.findByPk(original.id, { transaction: t });
    assert.equal(depois.fileId, fileAntigo);
    assert.equal(depois.versionNo, original.versionNo);
    assert.equal(depois.verificationStatus, 'VERIFIED');
    assert.equal(JSON.stringify(depois.extractedDataJson), leituraAntiga);
  });
});

test('POSITIVO: a troca cria nova versao PENDENTE, sem validacao herdada, com leitura ligada ao novo arquivo, e a antiga segue consultavel', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const { person, original, novoFile, fieldsB } = await pessoaComVerificado(t);
    const nova = await personDocuments.updateDocument(person.id, original.id, { fileId: novoFile.id }, tenant.userId, t);
    assert.notEqual(nova.id, original.id);
    assert.equal(nova.fileId, novoFile.id);
    assert.equal(nova.verificationStatus, 'PENDING');
    assert.equal(nova.verifiedBy, null);
    assert.ok(nova.versionNo > original.versionNo);
    assert.equal(nova.documentType, original.documentType);
    assert.equal(nova.extractedDataJson.sourceFileId, novoFile.id);
    assert.deepEqual(nova.extractedDataJson.fields, fieldsB);
    assert.equal(nova.extractedDataJson.manualFields, undefined, 'confirmacao manual anterior nao vale para o arquivo novo');
    const lista = await personDocuments.listDocuments(person.id, t);
    assert.ok(lista.some((d) => d.id === original.id && d.verificationStatus === 'VERIFIED'));
    assert.ok(lista.some((d) => d.id === nova.id));
    const aud = await AuditLog.findOne({ where: { entityId: nova.id, action: 'people.document.replace_file' }, transaction: t });
    assert.ok(aud, 'troca auditada');
    assert.match(aud.reason, /nova versão/i);
    // a nova versao precisa ser confirmada sobre o NOVO arquivo
    const confirmada = await personDocuments.updateDocument(person.id, nova.id, { verificationStatus: 'VERIFIED' }, tenant.userId, t);
    assert.equal(confirmada.verificationStatus, 'VERIFIED');
    assert.equal(confirmada.fileId, novoFile.id);
  });
});

test('NEGATIVO: trocar o arquivo e verificar na mesma chamada e recusado; arquivo de outra empresa/inexistente tambem; mesmo arquivo nao cria versao', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const { person, original, novoFile } = await pessoaComVerificado(t);
    const antes = await PersonDocument.count({ where: { personId: person.id }, transaction: t });
    await assert.rejects(
      personDocuments.updateDocument(person.id, original.id, { fileId: novoFile.id, verificationStatus: 'VERIFIED' }, tenant.userId, t),
      codigo('PERSON_DOCUMENT_REPLACE_FILE_WITH_STATUS')
    );
    await assert.rejects(
      personDocuments.updateDocument(person.id, original.id, { fileId: '00000000-0000-4000-8000-000000000000' }, tenant.userId, t),
      codigo('PERSON_DOCUMENT_FILE_NOT_FOUND')
    );
    assert.equal(await PersonDocument.count({ where: { personId: person.id }, transaction: t }), antes);
    // mesmo fileId: nao e troca, segue o fluxo normal sem nova versao
    await personDocuments.updateDocument(person.id, original.id, { fileId: original.fileId, expiresAt: '2030-01-01' }, tenant.userId, t);
    assert.equal(await PersonDocument.count({ where: { personId: person.id }, transaction: t }), antes);
  });
});

test('Caminho vizinho: documento PENDING/REJECTED tambem nao muda de arquivo mantendo a leitura antiga', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const { person, novoFile } = await pessoaComVerificado(t);
    const base = { groupId: tenant.groupId, companyId: tenant.companyId, personId: person.id, mimeType: 'application/pdf', documentType: 'RG' };
    const c = await ingestPersonDocument({ ...base, fileName: 'c.pdf', contentBase64: b64({ name: 'Fulano de Tal' }) }, tenant.userId, t);
    const nova = await personDocuments.updateDocument(person.id, c.personDocument.id, { fileId: novoFile.id }, tenant.userId, t);
    const antigo = await PersonDocument.findByPk(c.personDocument.id, { transaction: t });
    assert.equal(antigo.fileId, c.file.id);
    assert.equal(nova.fileId, novoFile.id);
    assert.equal(nova.extractedDataJson.sourceFileId, novoFile.id);
  });
});
