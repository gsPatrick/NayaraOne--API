'use strict';

// Pessoas — a verificação humana do documento é barrada no servidor quando a leitura é ilegível ou falta campo crítico.
// Mesma regra do Correspondente: dado ausente só passa se quem verifica informa, conferindo o arquivo original; o dado é
// validado no servidor e a intervenção fica registrada na nota do documento e na auditoria.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const personDocuments = require('../src/features/people/personDocuments.service');
const { Person, File, AuditLog } = require('../src/models');

let tenant;
const CPF_VALIDO = '52998224725';

before(async () => { tenant = await getSeedTenant(); });
after(async () => { await sequelize.close(); });

const codigo = (code) => (err) => err.code === code;

async function pessoaComDocumento(transaction, { documentType = 'IR', extractedDataJson = null, verificationStatus } = {}) {
  const person = await Person.create(
    { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `Pessoa doc ${uniqueSuffix()}`, createdBy: tenant.userId, updatedBy: tenant.userId },
    { transaction }
  );
  const file = await File.create(
    { groupId: tenant.groupId, companyId: tenant.companyId, fileName: `doc-${uniqueSuffix()}.pdf`, mimeType: 'application/pdf', sizeBytes: 2048, storageKey: `test/${uniqueSuffix()}.pdf`, uploadedByUserId: tenant.userId },
    { transaction }
  );
  const document = await personDocuments.createDocument(person.id, { documentType, fileId: file.id, extractedDataJson, ...(verificationStatus ? { verificationStatus } : {}), manualFields: undefined }, tenant.userId, transaction);
  return { person, document };
}

test('PES-DOC-01: documento ilegível nunca é verificado, nem com dados informados à mão', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const { person, document } = await pessoaComDocumento(t, { extractedDataJson: { fields: {}, illegible: true, confidence: 0 } });
    await assert.rejects(personDocuments.updateDocument(person.id, document.id, { verificationStatus: 'VERIFIED' }, tenant.userId, t), codigo('PERSON_DOCUMENT_ILLEGIBLE'));
    await assert.rejects(
      personDocuments.updateDocument(person.id, document.id, { verificationStatus: 'VERIFIED', manualFields: { name: 'Fulano de Tal', taxId: CPF_VALIDO, income: '5000' } }, tenant.userId, t),
      codigo('PERSON_DOCUMENT_ILLEGIBLE')
    );
    assert.equal((await personDocuments.getDocument(person.id, document.id, t)).verificationStatus, 'PENDING');
  });
});

test('PES-DOC-02: não dá para apagar o "ilegível" editando os dados lidos na mesma ficha', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const { person, document } = await pessoaComDocumento(t, { extractedDataJson: { fields: {}, illegible: true, confidence: 0 } });
    // Tentativa de adulterar o resultado da leitura e já verificar.
    await assert.rejects(
      personDocuments.updateDocument(person.id, document.id, { extractedDataJson: { fields: { name: 'X Y Z', taxId: CPF_VALIDO, income: 5000 }, illegible: false }, verificationStatus: 'VERIFIED' }, tenant.userId, t),
      codigo('PERSON_DOCUMENT_ILLEGIBLE')
    );
    // Só editar os campos mantém o ilegível gravado.
    const editado = await personDocuments.updateDocument(person.id, document.id, { extractedDataJson: { fields: { name: 'X Y Z' }, illegible: false } }, tenant.userId, t);
    assert.equal(editado.extractedDataJson.illegible, true);
    await assert.rejects(personDocuments.updateDocument(person.id, document.id, { verificationStatus: 'VERIFIED' }, tenant.userId, t), codigo('PERSON_DOCUMENT_ILLEGIBLE'));
  });
});

test('PES-DOC-03: campo crítico ausente barra a verificação e a mensagem diz o que falta', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const { person, document } = await pessoaComDocumento(t, { extractedDataJson: { fields: { name: 'Fulano de Tal' }, illegible: false, confidence: 0.95 } });
    await assert.rejects(
      personDocuments.updateDocument(person.id, document.id, { verificationStatus: 'VERIFIED' }, tenant.userId, t),
      (err) => err.code === 'PERSON_DOCUMENT_CRITICAL_FIELDS_MISSING' && /CPF\/CNPJ/.test(err.message) && /Renda/.test(err.message) && !/Nome/.test(err.message)
    );
    assert.equal((await personDocuments.getDocument(person.id, document.id, t)).verificationStatus, 'PENDING');
  });
});

test('PES-DOC-04: dado informado inválido continua barrando (CPF com dígitos errados, renda zero)', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const { person, document } = await pessoaComDocumento(t, { extractedDataJson: { fields: { name: 'Fulano de Tal' }, illegible: false, confidence: 0.95 } });
    await assert.rejects(personDocuments.updateDocument(person.id, document.id, { verificationStatus: 'VERIFIED', manualFields: { taxId: '11111111111', income: '5000' } }, tenant.userId, t), codigo('PERSON_DOCUMENT_MANUAL_FIELD_INVALID'));
    await assert.rejects(personDocuments.updateDocument(person.id, document.id, { verificationStatus: 'VERIFIED', manualFields: { taxId: CPF_VALIDO, income: '0' } }, tenant.userId, t), codigo('PERSON_DOCUMENT_MANUAL_FIELD_INVALID'));
    await assert.rejects(personDocuments.updateDocument(person.id, document.id, { verificationStatus: 'VERIFIED', manualFields: { taxId: '   ' } }, tenant.userId, t), codigo('PERSON_DOCUMENT_CRITICAL_FIELDS_MISSING'));
  });
});

test('PES-DOC-05: dado informado e conferido valida, e a nota e a auditoria registram que foi manual', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const { person, document } = await pessoaComDocumento(t, { extractedDataJson: { fields: { name: 'Fulano de Tal' }, illegible: false, confidence: 0.95 } });
    const verificado = await personDocuments.updateDocument(person.id, document.id, { verificationStatus: 'VERIFIED', manualFields: { taxId: '529.982.247-25', income: '5.000,00' } }, tenant.userId, t);
    assert.equal(verificado.verificationStatus, 'VERIFIED');
    assert.equal(verificado.verifiedBy, tenant.userId);
    assert.equal(verificado.extractedDataJson.manualFields.taxId, CPF_VALIDO);
    assert.equal(verificado.extractedDataJson.manualFields.income, 5000);
    assert.equal(verificado.extractedDataJson.manualFieldsConfirmedBy, tenant.userId);
    const auditoria = await AuditLog.findOne({ where: { entityId: document.id, action: 'people.document.update' }, order: [['occurred_at', 'DESC']], transaction: t });
    assert.match(auditoria.reason, /informado por quem verificou.*CPF\/CNPJ, Renda/);
  });
});

test('PES-DOC-06: leitura que achou todos os campos críticos verifica direto, sem pedir nada', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const { person, document } = await pessoaComDocumento(t, { extractedDataJson: { fields: { name: 'Fulano de Tal', taxId: CPF_VALIDO, income: 5000 }, illegible: false, confidence: 0.95 } });
    const verificado = await personDocuments.updateDocument(person.id, document.id, { verificationStatus: 'VERIFIED' }, tenant.userId, t);
    assert.equal(verificado.verificationStatus, 'VERIFIED');
    assert.equal(verificado.extractedDataJson.manualFields, undefined);
  });
});

test('PES-DOC-07: documento criado já como verificado passa pela mesma regra; tipo sem campo crítico verifica normalmente', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    // Sem leitura gravada pelo servidor: o que o cliente manda em extractedDataJson não vale como leitura.
    await assert.rejects(
      pessoaComDocumento(t, { documentType: 'IR', verificationStatus: 'VERIFIED', extractedDataJson: { fields: { name: 'Fulano de Tal', taxId: CPF_VALIDO, income: 5000 } } }),
      codigo('PERSON_DOCUMENT_CRITICAL_FIELDS_MISSING')
    );
    const { document } = await pessoaComDocumento(t, { documentType: 'OTHER', verificationStatus: 'VERIFIED' });
    assert.equal(document.verificationStatus, 'VERIFIED');
  });
});

test('PES-DOC-08: a revisão da tela (campos digitados junto com o status) vale como dado informado, com a mesma validação', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const { person, document } = await pessoaComDocumento(t, { extractedDataJson: { fields: { name: 'Fulano de Tal' }, illegible: false, confidence: 0.95 } });
    await assert.rejects(
      personDocuments.updateDocument(person.id, document.id, { verificationStatus: 'VERIFIED', extractedDataJson: { fields: { name: 'Fulano de Tal', taxId: '11111111111', income: 5000 }, reviewedByHuman: true } }, tenant.userId, t),
      codigo('PERSON_DOCUMENT_MANUAL_FIELD_INVALID')
    );
    const verificado = await personDocuments.updateDocument(person.id, document.id, { verificationStatus: 'VERIFIED', extractedDataJson: { fields: { name: 'Fulano de Tal', taxId: CPF_VALIDO, income: 5000 }, reviewedByHuman: true } }, tenant.userId, t);
    assert.equal(verificado.verificationStatus, 'VERIFIED');
    assert.equal(verificado.extractedDataJson.manualFields.taxId, CPF_VALIDO);
    assert.equal(verificado.extractedDataJson.confidence, 0.95, 'a confiança da leitura continua a gravada');
  });
});

test('PES-DOC-09: criar a pessoa já com documento verificado também passa pela regra', async () => {
  const personService = require('../src/features/people/person.service');
  await withRollbackTenantTransaction(tenant, async (t) => {
    const file = await File.create(
      { groupId: tenant.groupId, companyId: tenant.companyId, fileName: `doc-${uniqueSuffix()}.pdf`, mimeType: 'application/pdf', sizeBytes: 2048, storageKey: `test/${uniqueSuffix()}.pdf`, uploadedByUserId: tenant.userId },
      { transaction: t }
    );
    const base = () => ({ groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `Pessoa nova ${uniqueSuffix()}` });
    await assert.rejects(
      personService.createPerson({ ...base(), documents: [{ documentType: 'IR', fileId: file.id, verificationStatus: 'VERIFIED' }] }, tenant.userId, t),
      codigo('PERSON_DOCUMENT_CRITICAL_FIELDS_MISSING')
    );
    const ok = await personService.createPerson(
      { ...base(), documents: [{ documentType: 'IR', fileId: file.id, verificationStatus: 'VERIFIED', manualFields: { name: 'Fulano de Tal', taxId: CPF_VALIDO, income: '5000' } }] },
      tenant.userId,
      t
    );
    assert.ok(ok.id);
  });
});
