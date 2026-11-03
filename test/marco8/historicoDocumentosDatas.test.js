'use strict';

// Marco 8 — histórico de versões do documento mostra datas e validação reais; nenhum retorno do
// Correspondente devolve data de criação vazia (o modelo chama o atributo de `created_at`).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('../testHelpers');
const financingCasesService = require('../../src/features/correspondent/cases/financingCases.service');
const caseDocumentsService = require('../../src/features/correspondent/cases/caseDocuments.service');
const simulationsService = require('../../src/features/correspondent/cases/simulations.service');
const nay = require('../../src/features/correspondent/correspondentNay.service');
const { Person, File, CaseDocument } = require('../../src/models');

let tenant;
const ctx = () => ({ groupId: tenant.groupId, companyId: tenant.companyId });
before(async () => { tenant = await getSeedTenant(); });
after(async () => { await sequelize.close(); });

async function novoCaso(t, providerCode) {
  const pessoa = await Person.create(
    { ...ctx(), personType: 'PF', legalName: `Proponente HIST ${uniqueSuffix()}`, createdBy: tenant.userId, updatedBy: tenant.userId },
    { transaction: t }
  );
  return financingCasesService.createFinancingCase({ ...ctx(), ...(providerCode ? { providerCode } : {}), applicants: [{ personId: pessoa.id, role: 'PRINCIPAL' }] }, tenant.userId, t);
}

async function enviar(t, caso, requirementId) {
  const file = await File.create(
    { ...ctx(), fileName: `hist-${uniqueSuffix()}.pdf`, mimeType: 'application/pdf', sizeBytes: 2048, storageKey: `test/${uniqueSuffix()}.pdf`, uploadedByUserId: tenant.userId },
    { transaction: t }
  );
  const doc = await caseDocumentsService.uploadDocument(caso.id, requirementId, { fileId: file.id }, tenant.userId, ctx(), t);
  await CaseDocument.update({ readingStatus: 'NOT_READ', readingFoundFields: [] }, { where: { id: doc.id }, transaction: t });
  return doc;
}

test('M8-HIST-DOC-01: v1 e v2 mostram data de envio real; a validação aparece só na versão vigente e a v1 consta como substituída', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const caso = await novoCaso(t);
    const req = await caseDocumentsService.createRequirement(caso.id, { documentType: 'OUTRO' }, tenant.userId, ctx(), t);
    await enviar(t, caso, req.id);

    const antes = await caseDocumentsService.listDocumentVersions(caso.id, req.id, ctx(), t);
    assert.equal(antes.versions.length, 1);
    assert.equal(antes.versions[0].validation.status, 'PENDENTE');
    assert.ok(antes.versions[0].createdAt, 'data de envio da v1 nunca vem vazia');

    await enviar(t, caso, req.id);
    await caseDocumentsService.validateRequirement(caso.id, req.id, tenant.userId, ctx(), t);

    const lista = await caseDocumentsService.listDocumentVersions(caso.id, req.id, ctx(), t);
    assert.equal(lista.versions.length, 2, 'as duas versões continuam no histórico');
    const [v2, v1] = lista.versions;
    assert.equal(v2.version, 2);
    assert.equal(v1.version, 1);
    for (const v of [v1, v2]) {
      assert.ok(v.createdAt, `versão ${v.version} tem data de envio`);
      assert.ok(!Number.isNaN(new Date(v.createdAt).getTime()));
    }
    assert.equal(v2.current, true);
    assert.equal(v2.validation.status, 'VALIDADA');
    assert.equal(v2.validation.by, tenant.userId);
    assert.ok(v2.validation.at && !Number.isNaN(new Date(v2.validation.at).getTime()), 'data real da validação vem da auditoria');
    assert.equal(v1.current, false);
    assert.equal(v1.validation.status, 'SUBSTITUIDA');
    assert.equal(v1.validation.by, undefined, 'a versão substituída não afirma validação');
    assert.ok(v1.supersededAt);
    assert.equal(lista.requirement.validation.by, tenant.userId);
  });
});

test('M8-DATAS-01: simulações da comparação da NAY trazem a data de criação (createdAt nunca vazio)', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const caso = await novoCaso(t, 'sandbox');
    await simulationsService.createSimulation(caso.id, { amount: 100000, termMonths: 120 }, tenant.userId, tenant.groupId, tenant.companyId, t);
    await simulationsService.createSimulation(caso.id, { amount: 200000, termMonths: 240 }, tenant.userId, tenant.groupId, tenant.companyId, t);
    const cmp = await nay.compareSimulations(caso.id, tenant.groupId, tenant.companyId, t);
    assert.equal(cmp.simulations.length, 2);
    for (const s of cmp.simulations) {
      assert.ok(s.createdAt && !Number.isNaN(new Date(s.createdAt).getTime()), `simulação ${s.id} sem data`);
    }
  });
});
