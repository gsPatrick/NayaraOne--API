'use strict';

/**
 * M45 — cruzamento linha a linha do Caderno do Marco 5 (19/10/2026). Cada teste cobre uma linha
 * do Caderno que, no log do CI 39301913793, não tinha teste que a provasse de verdade (ou cuja
 * funcionalidade faltava e foi implementada junto). Postgres real, RLS ativo, tudo dentro de
 * transação com rollback (nada fica gravado).
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const peopleService = require('../src/features/people/people.service');
const contractsService = require('../src/features/legal/contracts.service');
const contractVersionsService = require('../src/features/legal/contractVersions.service');
const signaturesService = require('../src/features/legal/signatures.service');
const requirementsService = require('../src/features/legal/requirements.service');
const inspectionsService = require('../src/features/legal/inspections.service');
const legalCasesService = require('../src/features/legal/legalCases.service');
const legalDeadlinesService = require('../src/features/legal/legalDeadlines.service');
const evidencePackagesService = require('../src/features/legal/evidencePackages.service');
const utilitiesService = require('../src/features/billing/utilities.service');
const propertiesService = require('../src/features/properties/properties.service');
const { processDeadlinesInTransaction } = require('../src/engines/jobs/legalDeadlineAlertJob');
const { File, TenantSetting, OutboxEvent, Signature, Task, FinancialEntry, InspectionItem, OwnershipTransferTask } = require('../src/models');

let tenant;
before(async () => {
  tenant = await getSeedTenant();
});
after(async () => {
  await sequelize.close();
});

const codeIs = (code) => (err) => {
  assert.equal(err.code, code);
  return true;
};

async function clearSignatureSettings(transaction) {
  await TenantSetting.destroy({
    where: {
      companyId: tenant.companyId,
      key: ['legal.signature_provider', 'legal.clicksign_api_token', 'legal.clicksign_environment', 'legal.clicksign_webhook_secret', 'legal.zapsign_api_token', 'legal.zapsign_webhook_secret'],
    },
    transaction,
    force: true,
  });
}

async function fakeFile(transaction, ext = 'pdf') {
  const suffix = uniqueSuffix();
  return File.create(
    {
      groupId: tenant.groupId,
      companyId: tenant.companyId,
      storageKey: `m45/${suffix}.${ext}`,
      fileName: `evid-m45-${suffix}.${ext}`,
      mimeType: 'application/pdf',
      uploadedByUserId: tenant.userId,
      createdBy: tenant.userId,
      updatedBy: tenant.userId,
    },
    { transaction }
  );
}

async function leaseInSigning(transaction) {
  await clearSignatureSettings(transaction);
  const suffix = uniqueSuffix();
  const contract = await contractsService.createContract(
    { groupId: tenant.groupId, companyId: tenant.companyId, contractType: 'LEASE', totalValue: 1000 },
    tenant.userId,
    transaction
  );
  const people = [];
  for (const [role, name] of [['LANDLORD', 'Locador'], ['TENANT', 'Locatário']]) {
    const person = await peopleService.createPerson(
      { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `M45 ${name} ${suffix}` },
      tenant.userId,
      transaction
    );
    await contractsService.addContractParty(contract.id, { personId: person.id, partyRole: role }, tenant.userId, transaction);
    people.push(person);
  }
  await requirementsService.generateRequirementsForContract(contract.id, {}, tenant.userId, transaction);
  for (const item of await requirementsService.listRequirements(contract.id, transaction)) {
    if (item.status === 'PENDING') {
      await requirementsService.satisfyRequirement(item.id, { waivedReason: 'M45 — fora do escopo deste cenário' }, tenant.userId, transaction);
    }
  }
  await contractsService.transitionContractStatus(contract, 'DOCUMENTS_PENDING', tenant.userId, transaction);
  const file = await fakeFile(transaction);
  const version = await contractVersionsService.createContractVersion(
    contract.id,
    { content: `M45 corpo do contrato ${suffix}`, documentFileId: file.id },
    tenant.userId,
    transaction
  );
  await contractsService.transitionContractStatus(contract, 'LEGAL_REVIEW', tenant.userId, transaction);
  await contractsService.transitionContractStatus(contract, 'APPROVED', tenant.userId, transaction);
  await contractsService.transitionContractStatus(contract, 'SIGNING', tenant.userId, transaction);
  return { contract, version, people };
}

async function createProperty(transaction) {
  const suffix = uniqueSuffix();
  return propertiesService.createProperty(
    { groupId: tenant.groupId, companyId: tenant.companyId, title: `M45 Imóvel ${suffix}`, internalCode: `M45-${suffix}`, propertyType: 'RESIDENTIAL' },
    tenant.userId,
    transaction
  );
}

async function createCase(transaction, extra = {}) {
  return legalCasesService.createLegalCase(
    { groupId: tenant.groupId, companyId: tenant.companyId, caseType: 'LITIGATION', summary: `M45 processo ${uniqueSuffix()}`, responsibleUserId: tenant.userId, ...extra },
    tenant.userId,
    transaction
  );
}

test('M45-M5-01 JUR-TS-008: prazo jurídico sem origem (sourceDocument/sourceEvent) é bloqueado; com origem é criado', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const legalCase = await createCase(transaction);
    const dueAt = new Date(Date.now() + 5 * 86400000);
    await assert.rejects(
      () => legalDeadlinesService.createLegalDeadline(legalCase.id, { description: 'M45 contestação', dueAt }, tenant.userId, transaction),
      codeIs('LEGAL_DEADLINE_SOURCE_REQUIRED')
    );
    const ok = await legalDeadlinesService.createLegalDeadline(
      legalCase.id,
      { description: 'M45 contestação', dueAt, sourceDocument: 'Citação recebida em 19/10/2026' },
      tenant.userId,
      transaction
    );
    assert.equal(ok.sourceDocument, 'Citação recebida em 19/10/2026');
    assert.equal(ok.criticality, 'MEDIUM');
  });
});

test('M45-M5-02 §8 assinatura manual exige evidence_file_id, signatário parte do contrato e coletor; liga hash da versão e leva a SIGNED', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { contract, version, people } = await leaseInSigning(transaction);
    await assert.rejects(
      () => signaturesService.recordManualSignature(version.id, { personId: people[0].id }, tenant.userId, transaction),
      codeIs('LEGAL_MANUAL_SIGNATURE_EVIDENCE_REQUIRED')
    );
    const evidence = await fakeFile(transaction);
    const stranger = await peopleService.createPerson(
      { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `M45 Estranho ${uniqueSuffix()}` },
      tenant.userId,
      transaction
    );
    await assert.rejects(
      () => signaturesService.recordManualSignature(version.id, { personId: stranger.id, evidenceFileId: evidence.id }, tenant.userId, transaction),
      codeIs('LEGAL_SIGNATURE_SIGNER_NOT_PARTY')
    );
    await assert.rejects(
      () => signaturesService.recordManualSignature(version.id, { personId: people[0].id, evidenceFileId: '00000000-0000-4000-8000-000000000000' }, tenant.userId, transaction),
      codeIs('LEGAL_MANUAL_SIGNATURE_EVIDENCE_NOT_FOUND')
    );
    await signaturesService.recordManualSignature(version.id, { personId: people[0].id, evidenceFileId: evidence.id }, tenant.userId, transaction);
    const last = await signaturesService.recordManualSignature(version.id, { personId: people[1].id, evidenceFileId: evidence.id }, tenant.userId, transaction);
    assert.equal(last.contractTransitioned, true);
    const sigs = await Signature.findAll({ where: { contractVersionId: version.id }, transaction });
    assert.equal(sigs.length, 2);
    for (const s of sigs) {
      assert.equal(s.signatureMethod, 'MANUAL');
      assert.equal(s.status, 'SIGNED');
      assert.equal(s.evidenceFileId, evidence.id);
      assert.equal(s.collectedByUserId, tenant.userId);
      assert.equal(s.contentHash, version.contentHash);
    }
    assert.equal((await contractsService.getContract(contract.id, transaction)).status, 'SIGNED');
    // O banco também recusa assinatura MANUAL sem evidência/coletor (CHECK).
    await assert.rejects(
      () => sequelize.transaction({ transaction }, (sp) =>
        sequelize.query('UPDATE legal.signatures SET evidence_file_id = NULL WHERE id = :id', { replacements: { id: sigs[0].id }, transaction: sp })),
      /signatures_manual_evidence_chk/
    );
  });
});

test('M45-M5-03 JUR-TS-002/§8: webhook com hash diferente da versão enviada é rejeitado; o mesmo hash confirma', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { version, people } = await leaseInSigning(transaction);
    const [sig] = await signaturesService.initiateSignature(version.id, [people[0].id], tenant.userId, transaction);
    assert.equal(sig.contentHash, version.contentHash);
    await assert.rejects(
      () => signaturesService.handleSignatureWebhook(sig.externalSignatureId, { contentHash: 'f'.repeat(64) }, transaction),
      codeIs('LEGAL_SIGNATURE_HASH_MISMATCH')
    );
    const ok = await signaturesService.handleSignatureWebhook(sig.externalSignatureId, { contentHash: version.contentHash }, transaction);
    assert.equal(ok.signature.status, 'SIGNED');
  });
});

test('M45-M5-04 §8: conteúdo mudou depois do envio — envelope pendente é cancelado, contrato volta a APPROVED e a versão antiga fica intacta', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { contract, version, people } = await leaseInSigning(transaction);
    const sigs = await signaturesService.initiateSignature(version.id, people.map((p) => p.id), tenant.userId, transaction);
    const file = await fakeFile(transaction);
    const v2 = await contractVersionsService.createContractVersion(contract.id, { content: 'M45 corpo ALTERADO', documentFileId: file.id }, tenant.userId, transaction);
    assert.equal(v2.versionNumber, version.versionNumber + 1);
    for (const s of sigs) {
      const reloaded = await Signature.findByPk(s.id, { transaction });
      assert.equal(reloaded.status, 'CANCELLED');
    }
    assert.equal((await contractsService.getContract(contract.id, transaction)).status, 'APPROVED');
    await assert.rejects(() => signaturesService.handleSignatureWebhook(sigs[0].externalSignatureId, {}, transaction), codeIs('LEGAL_SIGNATURE_CANCELLED'));
    const v1 = await contractVersionsService.getContractVersion(version.id, transaction);
    assert.equal(v1.contentHash, version.contentHash);
  });
});

test('M45-M5-05 §11: tipos ENTRY/EXIT/INTERMEDIATE/FINAL do Caderno são aceitos (sinônimos gravados como CHECK_IN/CHECK_OUT/PERIODIC); tipo inventado é recusado', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const property = await createProperty(transaction);
    const expected = { ENTRY: 'CHECK_IN', EXIT: 'CHECK_OUT', INTERMEDIATE: 'PERIODIC', FINAL: 'FINAL' };
    for (const [type, stored] of Object.entries(expected)) {
      const insp = await inspectionsService.createInspection(
        { groupId: tenant.groupId, companyId: tenant.companyId, propertyId: property.id, inspectionType: type },
        tenant.userId,
        transaction
      );
      assert.equal(insp.inspectionType, stored);
    }
    await assert.rejects(
      () => inspectionsService.createInspection({ groupId: tenant.groupId, companyId: tenant.companyId, propertyId: property.id, inspectionType: 'QUALQUER' }, tenant.userId, transaction),
      codeIs('LEGAL_INSPECTION_VALIDATION')
    );
  });
});

test('M45-M5-06 JUR-TS-006/§11: correção de vistoria assinada cria revisão com itens copiados; o laudo original continua intacto e imutável', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const property = await createProperty(transaction);
    const insp = await inspectionsService.createInspection(
      { groupId: tenant.groupId, companyId: tenant.companyId, propertyId: property.id, inspectionType: 'ENTRY' },
      tenant.userId,
      transaction
    );
    await inspectionsService.addInspectionItem(insp.id, { itemName: 'M45 Piso', condition: 'GOOD' }, tenant.userId, transaction);
    await inspectionsService.completeInspection(insp.id, tenant.userId, transaction);
    await assert.rejects(
      () => inspectionsService.createInspectionRevision(insp.id, { reason: 'M45 ajuste' }, tenant.userId, transaction),
      codeIs('LEGAL_INSPECTION_REVISION_NOT_SIGNED')
    );
    await inspectionsService.signInspection(insp.id, { partyRole: 'INSPECTOR', signaturePayload: 'M45' }, tenant.userId, transaction);
    await assert.rejects(() => inspectionsService.createInspectionRevision(insp.id, {}, tenant.userId, transaction), codeIs('LEGAL_INSPECTION_REVISION_REASON_REQUIRED'));
    const revision = await inspectionsService.createInspectionRevision(insp.id, { reason: 'M45 risco no piso omitido' }, tenant.userId, transaction);
    assert.equal(revision.revisionOfInspectionId, insp.id);
    assert.notEqual(revision.id, insp.id);
    const revItems = await InspectionItem.findAll({ where: { inspectionId: revision.id }, transaction });
    assert.equal(revItems.length, 1);
    await inspectionsService.addInspectionItem(revision.id, { itemName: 'M45 Risco', condition: 'REGULAR' }, tenant.userId, transaction);
    assert.equal((await InspectionItem.findAll({ where: { inspectionId: insp.id }, transaction })).length, 1, 'original não ganhou item');
    await assert.rejects(
      () => inspectionsService.addInspectionItem(insp.id, { itemName: 'x', condition: 'GOOD' }, tenant.userId, transaction),
      codeIs('LEGAL_INSPECTION_IMMUTABLE_AFTER_SIGNATURE')
    );
    const ev = await OutboxEvent.findOne({ where: { eventType: 'inspection.signed', aggregateId: insp.id }, transaction });
    assert.ok(ev, 'inspection.signed publicado');
  });
});

test('M45-M5-07 §18: eventos mínimos com o nome do Caderno — contract.created, contract.requirement.missing, contract.version.approved, contract.sent_for_signature, contract.signed, evidence.package.created', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { contract, version, people } = await leaseInSigning(transaction);
    const sigs = await signaturesService.initiateSignature(version.id, people.map((p) => p.id), tenant.userId, transaction);
    for (const s of sigs) await signaturesService.handleSignatureWebhook(s.externalSignatureId, {}, transaction);
    for (const type of ['contract.created', 'contract.requirement.missing', 'contract.version.approved', 'contract.sent_for_signature', 'contract.signed']) {
      const ev = await OutboxEvent.findOne({ where: { eventType: type, aggregateId: contract.id }, transaction });
      assert.ok(ev, `${type} publicado`);
    }
    const sent = await OutboxEvent.findOne({ where: { eventType: 'contract.sent_for_signature', aggregateId: contract.id }, transaction });
    assert.equal(sent.payloadJson.contentHash, version.contentHash);
    const legalCase = await createCase(transaction);
    const pkg = await evidencePackagesService.createEvidencePackage(
      legalCase.id,
      [{ type: 'CONTRACT', description: 'M45 contrato', referenceId: null, hash: 'abc123' }],
      tenant.userId,
      transaction
    );
    assert.ok(await OutboxEvent.findOne({ where: { eventType: 'evidence.package.created', aggregateId: pkg.id }, transaction }));
  });
});

test('M45-M5-08 §14: processo guarda órgão, classe, valor ESTIMADO e risco; risco inválido é recusado; estimativa não cria recebível', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const entriesBefore = await FinancialEntry.count({ transaction });
    const legalCase = await createCase(transaction, { caseNumber: '0001234-56.2026.8.26.0100', court: '1ª Vara Cível', caseClass: 'Despejo por falta de pagamento', estimatedAmount: '15000.50', riskLevel: 'high' });
    assert.equal(legalCase.court, '1ª Vara Cível');
    assert.equal(legalCase.caseClass, 'Despejo por falta de pagamento');
    assert.equal(Number(legalCase.estimatedAmount), 15000.5);
    assert.equal(legalCase.riskLevel, 'HIGH');
    await assert.rejects(() => createCase(transaction, { riskLevel: 'ALTISSIMO' }), codeIs('LEGAL_CASE_VALIDATION'));
    await assert.rejects(() => createCase(transaction, { estimatedAmount: -1 }), codeIs('LEGAL_CASE_VALIDATION'));
    const updated = await legalCasesService.updateLegalCase(legalCase.id, { riskLevel: 'CRITICAL', estimatedAmount: 20000 }, tenant.userId, transaction);
    assert.equal(updated.riskLevel, 'CRITICAL');
    assert.equal(await FinancialEntry.count({ transaction }), entriesBefore, 'nenhum lançamento financeiro nasce da estimativa processual');
  });
});

test('M45-M5-09 §15: prazo CRITICAL vencido abre UMA ocorrência CRITICAL e publica legal.deadline.overdue; prazo MEDIUM vencido não abre ocorrência', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const legalCase = await createCase(transaction);
    const past = new Date(Date.now() - 3 * 86400000);
    await assert.rejects(
      () => legalDeadlinesService.createLegalDeadline(legalCase.id, { description: 'x', dueAt: past, sourceEvent: 'm45', responsibleUserId: tenant.userId, criticality: 'URGENTE' }, tenant.userId, transaction),
      codeIs('LEGAL_DEADLINE_VALIDATION')
    );
    const critical = await legalDeadlinesService.createLegalDeadline(
      legalCase.id,
      { description: 'M45 recurso', dueAt: past, sourceEvent: 'Intimação M45', responsibleUserId: tenant.userId, criticality: 'CRITICAL' },
      tenant.userId,
      transaction
    );
    const medium = await legalDeadlinesService.createLegalDeadline(
      legalCase.id,
      { description: 'M45 juntada', dueAt: past, sourceEvent: 'Despacho M45', responsibleUserId: tenant.userId },
      tenant.userId,
      transaction
    );
    await processDeadlinesInTransaction(transaction);
    await processDeadlinesInTransaction(transaction);
    const tasks = await Task.findAll({ where: { relatedEntityType: 'legal.legal_deadlines', relatedEntityId: critical.id }, transaction });
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].priority, 'CRITICAL');
    assert.equal(tasks[0].assignedToUserId, tenant.userId);
    assert.equal(await Task.count({ where: { relatedEntityType: 'legal.legal_deadlines', relatedEntityId: medium.id }, transaction }), 0);
    assert.ok(await OutboxEvent.findOne({ where: { eventType: 'legal.deadline.overdue', aggregateId: critical.id }, transaction }));
  });
});

test('M45-M5-10 §12/§18: troca de titularidade pendente há mais de 30 dias publica lease.obligation.overdue uma única vez e continua pendente', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const contract = await contractsService.createContract(
      { groupId: tenant.groupId, companyId: tenant.companyId, contractType: 'LEASE', totalValue: 1000 },
      tenant.userId,
      transaction
    );
    const { obligation, transferTask } = await utilitiesService.createUtilityObligation(
      { groupId: tenant.groupId, companyId: tenant.companyId, contractId: contract.id, utilityType: 'ELECTRICITY', responsibleParty: 'TENANT', transferRequired: true },
      tenant.userId,
      transaction
    );
    assert.ok(transferTask, 'tarefa de troca de titularidade criada');
    const later = new Date(Date.now() + 31 * 86400000);
    const first = await utilitiesService.flagOverdueLeaseObligations(transaction, { now: later });
    const second = await utilitiesService.flagOverdueLeaseObligations(transaction, { now: later });
    assert.ok(first.flagged >= 1);
    assert.equal(second.flagged, 0, 'idempotente');
    const events = await OutboxEvent.findAll({ where: { eventType: 'lease.obligation.overdue', aggregateId: transferTask.id }, transaction });
    assert.equal(events.length, 1);
    assert.equal(events[0].payloadJson.utilityObligationId, obligation.id);
    assert.equal((await OwnershipTransferTask.findByPk(transferTask.id, { transaction })).status, 'PENDING');
    const notYet = await utilitiesService.flagOverdueLeaseObligations(transaction, { now: new Date() });
    assert.equal(notYet.flagged, 0);
  });
});

test('M45-M5-11 §16: cada exportação do dossiê gera um id de exportação novo e o hash do manifesto exportado; a integridade continua verificável', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const legalCase = await createCase(transaction);
    const pkg = await evidencePackagesService.createEvidencePackage(
      legalCase.id,
      [{ type: 'CONTRACT', description: 'M45 contrato', referenceId: null, hash: 'abc123' }],
      tenant.userId,
      transaction
    );
    const a = await evidencePackagesService.exportEvidencePackage(pkg.id, tenant.userId, transaction);
    const b = await evidencePackagesService.exportEvidencePackage(pkg.id, tenant.userId, transaction);
    assert.match(a.exportPackageId, /^[0-9a-f-]{36}$/);
    assert.notEqual(a.exportPackageId, b.exportPackageId);
    assert.notEqual(a.exportPackageId, pkg.id);
    assert.match(a.exportManifestHash, /^[0-9a-f]{64}$/);
    assert.equal(evidencePackagesService.verifyEvidencePackageIntegrity(a, pkg.packageHash).valid, true);
  });
});
