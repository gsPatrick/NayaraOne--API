'use strict';

// Item 2 do ciclo de auditoria externa (Marco 3). Contrato bruto — Guia do Marcelo §5
// ("Cadastro por documento e IA"):
//   "Upload -> antivírus -> hash -> classificação -> OCR/IA -> dados sugeridos."
//   "Dados extraídos ficam com source_file_id e confidence."
//   "CPF/CNPJ, nome, renda, conta e datas críticas exigem validação antes de persistir..."
//   "Documento ilegível gera pendência, não dado inventado."
// Até este ciclo só existia validação de CPF/CNPJ DIGITADO manualmente — este teste prova o
// pipeline completo (antivírus -> hash -> classificação -> OCR mockável -> validação ->
// persistência com source_file_id/confidence, e pendência real quando ilegível).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const personService = require('../src/features/people/person.service');
const { ingestPersonDocument, CONFIDENCE_THRESHOLD } = require('../src/features/people/documentIngestion.service');
const { EICAR_SIGNATURE } = require('../src/features/people/adapters/AntivirusAdapter');
const { Task } = require('../src/models');

let tenant;

before(async () => {
  tenant = await getSeedTenant();
});

after(async () => {
  await sequelize.close();
});

function mockOcrBase64(fields, confidence) {
  const payload = { __mockOcr: { fields, confidence } };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

test('ingestPersonDocument: documento legível com dados válidos é persistido com sourceFileId/confidence (sem auto-verificar)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const person = await personService.createPerson(
      { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `Ingestão OCR ${suffix}` },
      tenant.userId,
      transaction
    );

    const { file, personDocument, pendingTask } = await ingestPersonDocument(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        personId: person.id,
        fileName: 'holerite.pdf',
        mimeType: 'application/pdf',
        documentType: 'HOLERITE',
        contentBase64: mockOcrBase64({ name: person.legalName, income: 5000.5 }, 0.92),
      },
      tenant.userId,
      transaction
    );

    assert.ok(file.id);
    assert.ok(personDocument.id);
    assert.equal(personDocument.extractedDataJson.sourceFileId, file.id);
    assert.equal(personDocument.extractedDataJson.confidence, 0.92);
    assert.equal(personDocument.extractedDataJson.fields.income, 5000.5);
    // "IA nunca sobrescreve cadastro existente silenciosamente" — mesmo com alta confiança e
    // campos válidos, fica PENDING até confirmação humana (nunca vira VERIFIED sozinho).
    assert.equal(personDocument.verificationStatus, 'PENDING');
    assert.equal(pendingTask, null, 'documento legível/válido não precisa abrir pendência de revisão por ilegibilidade');
  });
});

test('ingestPersonDocument: documento ilegível (OCR sem extrair nada) gera pendência (Task) e NÃO inventa dados', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const person = await personService.createPerson(
      { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `Ingestão Ilegível ${suffix}` },
      tenant.userId,
      transaction
    );

    const { personDocument, pendingTask } = await ingestPersonDocument(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        personId: person.id,
        fileName: 'documento-ilegivel.pdf',
        mimeType: 'application/pdf',
        documentType: 'HOLERITE',
        contentBase64: Buffer.from('conteúdo binário sem marcador OCR nenhum').toString('base64'),
      },
      tenant.userId,
      transaction
    );

    assert.equal(personDocument.verificationStatus, 'PENDING');
    assert.deepEqual(personDocument.extractedDataJson.fields, {}, 'documento ilegível não pode ter campo inventado');
    assert.equal(personDocument.extractedDataJson.illegible, true);
    assert.ok(pendingTask, 'documento ilegível precisa abrir uma pendência real (Task)');
    assert.equal(pendingTask.relatedEntityType, 'people.persons');
    assert.equal(pendingTask.relatedEntityId, person.id);

    const reloadedTask = await Task.findByPk(pendingTask.id, { transaction });
    assert.ok(reloadedTask, 'a pendência precisa estar de fato persistida em core.tasks');
  });
});

test('ingestPersonDocument: confiança abaixo do mínimo também gera pendência, mesmo com fields presentes', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const person = await personService.createPerson(
      { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `Ingestão Baixa Confianca ${suffix}` },
      tenant.userId,
      transaction
    );

    const { personDocument, pendingTask } = await ingestPersonDocument(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        personId: person.id,
        fileName: 'rg-borrado.pdf',
        mimeType: 'application/pdf',
        documentType: 'RG',
        contentBase64: mockOcrBase64({ name: person.legalName }, CONFIDENCE_THRESHOLD - 0.1),
      },
      tenant.userId,
      transaction
    );

    assert.equal(personDocument.verificationStatus, 'PENDING');
    assert.ok(pendingTask, 'confiança abaixo do mínimo precisa abrir pendência mesmo com fields presentes');
  });
});

test('ingestPersonDocument: CPF extraído em formato inválido (IR) é rejeitado antes de persistir', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const person = await personService.createPerson(
      { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `Ingestão CPF Invalido ${suffix}` },
      tenant.userId,
      transaction
    );

    await assert.rejects(
      () =>
        ingestPersonDocument(
          {
            groupId: tenant.groupId,
            companyId: tenant.companyId,
            personId: person.id,
            fileName: 'ir.pdf',
            mimeType: 'application/pdf',
            documentType: 'IR',
            contentBase64: mockOcrBase64({ name: person.legalName, taxId: '123', income: 3000 }, 0.95),
          },
          tenant.userId,
          transaction
        ),
      (err) => { assert.equal(err.code, 'PERSON_DOCUMENT_INVALID_FORMAT'); return true; },
      'CPF extraído pela OCR com formato inválido precisa ser rejeitado antes de persistir (fail-closed), não gravado como se fosse válido'
    );
  });
});

test('ingestPersonDocument: arquivo com assinatura de malware (EICAR) é rejeitado em quarentena, nunca persistido', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const person = await personService.createPerson(
      { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `Ingestão Malware ${suffix}` },
      tenant.userId,
      transaction
    );

    const { PersonDocument } = require('../src/models');
    const beforeCount = await PersonDocument.count({ where: { personId: person.id }, transaction });

    await assert.rejects(
      () =>
        ingestPersonDocument(
          {
            groupId: tenant.groupId,
            companyId: tenant.companyId,
            personId: person.id,
            fileName: 'arquivo-infectado.pdf',
            mimeType: 'application/pdf',
            documentType: 'RG',
            contentBase64: Buffer.from(EICAR_SIGNATURE).toString('base64'),
          },
          tenant.userId,
          transaction
        ),
      (err) => { assert.equal(err.code, 'DOCUMENT_INGESTION_MALWARE_DETECTED'); return true; },
      'antivírus precisa bloquear ANTES do hash/OCR/persistência — quarentena real'
    );

    const afterCount = await PersonDocument.count({ where: { personId: person.id }, transaction });
    assert.equal(afterCount, beforeCount, 'arquivo infectado não pode deixar nenhum registro de documento gravado');
  });
});
