'use strict';

// Marco 8 — lacunas da revisão de 24/10/2026: revisão de duplicata, erros de integração,
// resumo da NAY, comissões × fiscal, NFS-e recusada e DIMOB com origem em locação.
// Escrito para rodar com `node --test test/marco8/lacunasRevisao.test.js` (não executado na entrega).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('../testHelpers');
const financingCases = require('../../src/features/correspondent/cases/financingCases.service');
const documentsService = require('../../src/features/correspondent/cases/caseDocuments.service');
const commissions = require('../../src/features/correspondent/cases/commissionEntitlements.service');
const duplicates = require('../../src/features/correspondent/correspondentDuplicate.service');
const integrationErrors = require('../../src/features/correspondent/integrationErrors.service');
const nay = require('../../src/features/correspondent/correspondentNay.service');
const parameters = require('../../src/features/correspondent/parameters.service');
const nfse = require('../../src/features/correspondent/fiscal/nfse.service');
const recon = require('../../src/features/correspondent/fiscal/reconciliation.service');
const dimob = require('../../src/features/correspondent/fiscal/dimob.service');
const { SANDBOX_REJECT_MARKER } = require('../../src/features/correspondent/adapters/NfseAdapter');
const workflow = require('../../src/features/correspondent/cases/caseWorkflow.service');
const simulationsService = require('../../src/features/correspondent/cases/simulations.service');
const submissionsService = require('../../src/features/correspondent/cases/submissions.service');
const { SandboxFinancingProviderAdapter } = require('../../src/features/correspondent/adapters/FinancingProviderAdapter');
const { Person, Property, Contract, ContractParty, FinancialEntry, FinancingCase, File, CaseDocument, IntegrationError } = require('../../src/models');

let tenant;
before(async () => { tenant = await getSeedTenant(); });
after(async () => { await sequelize.close(); });

const ctx = () => ({ groupId: tenant.groupId, companyId: tenant.companyId });
const a = () => [tenant.userId, tenant.groupId, tenant.companyId];
const codigo = (c) => (err) => { assert.equal(err.code, c, `esperava ${c}, veio ${err.code}: ${err.message}`); return true; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pessoa(t, nome = 'Proponente lacunas', extra = {}) {
  return Person.create({ ...ctx(), personType: 'PF', legalName: `${nome} ${uniqueSuffix()}`, createdBy: tenant.userId, updatedBy: tenant.userId, ...extra }, { transaction: t });
}

async function novoCaso(t, principal, extra = {}) {
  return financingCases.createFinancingCase(
    { ...ctx(), providerCode: 'manual', applicants: [{ personId: principal.id, role: 'PRINCIPAL' }], ...extra },
    tenant.userId,
    t
  );
}

async function comissaoRecebivel(t, base = 40000) {
  const caso = await novoCaso(t, await pessoa(t));
  const e = await commissions.createCommissionEntitlement(caso.id, { baseAmount: base }, ...a().slice(0, 1), tenant.groupId, tenant.companyId, t);
  return commissions.confirmCommissionEntitlement(e.id, { externalConfirmationId: `lac-${uniqueSuffix()}` }, tenant.userId, tenant.groupId, tenant.companyId, t);
}

// ---------- Duplicata ----------

test('M8-DUP-01: segundo caso do mesmo proponente entra na fila; descartar mantém o caso; decisão exige nota', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const principal = await pessoa(t);
    const primeiro = await novoCaso(t, principal);
    const segundo = await novoCaso(t, principal);
    assert.equal(segundo.possibleDuplicateOfCaseId, primeiro.id);
    assert.equal(segundo.duplicateReviewStatus, 'PENDING');

    const fila = await duplicates.listPendingDuplicateReviews(tenant.groupId, tenant.companyId, t);
    const item = fila.find((c) => c.id === segundo.id);
    assert.ok(item);
    assert.equal(item.originalCase.id, primeiro.id);

    await assert.rejects(duplicates.reviewDuplicate(segundo.id, { decision: 'DISMISS', note: 'x' }, ...a(), t), codigo('CASE_DUPLICATE_REVIEW_VALIDATION'));
    await assert.rejects(duplicates.reviewDuplicate(segundo.id, { decision: 'TALVEZ', note: 'nota válida' }, ...a(), t), codigo('CASE_DUPLICATE_REVIEW_VALIDATION'));
    await assert.rejects(duplicates.reviewDuplicate(primeiro.id, { decision: 'DISMISS', note: 'nota válida' }, ...a(), t), codigo('CASE_DUPLICATE_REVIEW_NOT_PENDING'));

    const r = await duplicates.reviewDuplicate(segundo.id, { decision: 'DISMISS', note: 'São duas operações diferentes' }, ...a(), t);
    assert.equal(r.financingCase.duplicateReviewStatus, 'DISMISSED');
    assert.equal(r.financingCase.status, 'DRAFT');
    assert.ok(r.financingCase.duplicateReviewedAt);
    await assert.rejects(duplicates.reviewDuplicate(segundo.id, { decision: 'CONFIRM', note: 'de novo' }, ...a(), t), codigo('CASE_DUPLICATE_REVIEW_NOT_PENDING'));
    const filaDepois = await duplicates.listPendingDuplicateReviews(tenant.groupId, tenant.companyId, t);
    assert.ok(!filaDepois.some((c) => c.id === segundo.id));
  });
});

test('M8-DUP-02: confirmar a duplicata cancela o caso novo com motivo e preserva o original', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const principal = await pessoa(t);
    const primeiro = await novoCaso(t, principal);
    const segundo = await novoCaso(t, principal);
    const r = await duplicates.reviewDuplicate(segundo.id, { decision: 'CONFIRM', note: 'Mesmo financiamento digitado duas vezes' }, ...a(), t);
    assert.equal(r.originalCaseId, primeiro.id);
    assert.equal(r.financingCase.duplicateReviewStatus, 'CONFIRMED');
    assert.equal(r.financingCase.status, 'CANCELED');
    assert.match(r.financingCase.canceledReason, /^Duplicata do caso criado em \d{2}\/\d{2}\/\d{4}/);
    assert.ok(!r.financingCase.canceledReason.includes(primeiro.id), 'o motivo mostrado ao usuário não carrega UUID');
    const original = await FinancingCase.findByPk(primeiro.id, { transaction: t });
    assert.equal(original.status, 'DRAFT');
  });
});

// ---------- Erros de integração ----------

test('M8-INT-01: erro de integração aparece aberto, filtra por status e só resolve com nota, uma vez', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const e = await integrationErrors.recordIntegrationError(
      { ...ctx(), providerCode: 'sandbox', operation: 'submit', errorCode: 'TESTE_LACUNA', message: 'Falha de teste do envio' },
      t
    );
    const abertos = await integrationErrors.listIntegrationErrors({ status: 'OPEN' }, tenant.groupId, tenant.companyId, t);
    const meu = abertos.find((x) => x.id === e.id);
    assert.ok(meu);
    assert.equal(meu.operationLabel, 'Envio do caso');
    await assert.rejects(integrationErrors.listIntegrationErrors({ status: 'QUALQUER' }, tenant.groupId, tenant.companyId, t), codigo('INTEGRATION_ERROR_VALIDATION'));
    await assert.rejects(integrationErrors.resolveIntegrationError(e.id, '', ...a(), t), codigo('INTEGRATION_ERROR_VALIDATION'));
    const r = await integrationErrors.resolveIntegrationError(e.id, 'Provider voltou, reenviado', ...a(), t);
    assert.equal(r.status, 'RESOLVED');
    assert.ok(r.resolvedAt);
    await assert.rejects(integrationErrors.resolveIntegrationError(e.id, 'de novo', ...a(), t), codigo('INTEGRATION_ERROR_ALREADY_RESOLVED'));
    const resolvidos = await integrationErrors.listIntegrationErrors({ status: 'RESOLVED' }, tenant.groupId, tenant.companyId, t);
    assert.ok(resolvidos.some((x) => x.id === e.id));
    await assert.rejects(integrationErrors.resolveIntegrationError('00000000-0000-0000-0000-000000000000', 'nota', ...a(), t), codigo('INTEGRATION_ERROR_NOT_FOUND'));
  });
});

// ---------- NAY: resumo ----------

test('M8-NAY-RES-01: resumo cita a origem de cada linha, aponta pendência e não decide nem altera o caso', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const caso = await novoCaso(t, await pessoa(t));
    await documentsService.createRequirement(caso.id, { documentType: 'RG_CPF' }, tenant.userId, ctx(), t);
    const antes = (await FinancingCase.findByPk(caso.id, { transaction: t })).toJSON();
    const resumo = await nay.summarizeCase(caso.id, tenant.groupId, tenant.companyId, t);
    assert.equal(resumo.method, 'RULE_BASED');
    assert.deepEqual(resumo.decisionsMade, []);
    assert.match(resumo.disclaimer, /não aprova crédito/);
    assert.ok(resumo.lines.every((l) => l.source && l.text));
    const docs = resumo.lines.find((l) => l.topic === 'Documentos');
    assert.match(docs.text, /RG\/CPF/);
    assert.ok(resumo.suggestions.some((s) => /RG\/CPF/.test(s)));
    const prosa = JSON.stringify(resumo).toLowerCase();
    assert.ok(!/(será aprovad|vai ser aprovad|garant)/.test(prosa), 'nenhuma promessa');
    const depois = (await FinancingCase.findByPk(caso.id, { transaction: t })).toJSON();
    assert.deepEqual(depois, antes, 'a NAY não altera o caso');
    await assert.rejects(nay.summarizeCase('00000000-0000-0000-0000-000000000000', tenant.groupId, tenant.companyId, t), codigo('FINANCING_CASE_NOT_FOUND'));
  });
});

// ---------- Comissões × fiscal ----------

test('M8-CXF-01: comissão sem NFS-e só vira issue depois do prazo; emitir a nota encerra a issue sozinha', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const e = await comissaoRecebivel(t);
    const abertas = async () => (await recon.listReconciliations('OPEN', tenant.groupId, tenant.companyId, t)).filter((r) => r.reconciliationType === 'COMMISSION_X_FISCAL' && r.referenceId === e.id);

    await recon.runReconciliations(tenant.userId, tenant.groupId, tenant.companyId, t);
    assert.equal((await abertas()).length, 0, 'dentro do prazo não abre issue');

    const atual = await parameters.getParameters(tenant.groupId, tenant.companyId, tenant.userId, t);
    assert.equal(atual.commission.action.invoiceGraceDays, 5);
    await assert.rejects(parameters.updateCommission({ ...atual.commission.action, invoiceGraceDays: -1 }, 'prazo inválido', ...a(), t), codigo('CORRESPONDENT_PARAMETERS_VALIDATION'));
    await parameters.updateCommission({ ...atual.commission.action, invoiceGraceDays: 0 }, 'Sem prazo para a nota', ...a(), t);

    const r1 = await recon.runReconciliations(tenant.userId, tenant.groupId, tenant.companyId, t);
    const issue = r1.opened.find((x) => x.reconciliationType === 'COMMISSION_X_FISCAL' && x.referenceId === e.id);
    assert.ok(issue, 'sem prazo, a comissão sem nota abre issue');
    assert.equal(Number(issue.differenceAmount), Number(e.amount));

    await recon.runReconciliations(tenant.userId, tenant.groupId, tenant.companyId, t);
    assert.equal((await abertas()).length, 1, 'rodar de novo não duplica');

    await nfse.requestInvoice({ sourceType: 'COMMISSION_ENTITLEMENT', sourceId: e.id, amount: Number(e.amount), description: `Nota da comissão ${uniqueSuffix()}` }, ...a(), t);
    await recon.runReconciliations(tenant.userId, tenant.groupId, tenant.companyId, t);
    assert.equal((await abertas()).length, 0, 'a nota do mesmo valor encerra a issue');
  });
});

test('M8-CXF-02: nota com valor diferente da comissão abre issue COMMISSION_X_FISCAL', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const e = await comissaoRecebivel(t);
    await nfse.requestInvoice({ sourceType: 'COMMISSION_ENTITLEMENT', sourceId: e.id, amount: Number(e.amount) + 50, description: `Nota maior ${uniqueSuffix()}` }, ...a(), t);
    const r = await recon.runReconciliations(tenant.userId, tenant.groupId, tenant.companyId, t);
    const issue = r.opened.find((x) => x.reconciliationType === 'COMMISSION_X_FISCAL' && x.referenceId === e.id);
    assert.ok(issue);
    assert.equal(Number(issue.differenceAmount), -50);
  });
});

// ---------- NFS-e recusada ----------

test('M8-NFSE-REJ-01: emissor recusa a nota, o estado é final e uma nova solicitação para a origem é permitida', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const e = await comissaoRecebivel(t);
    const inv = await nfse.requestInvoice({ sourceType: 'COMMISSION_ENTITLEMENT', sourceId: e.id, amount: Number(e.amount), description: `Nota a recusar ${SANDBOX_REJECT_MARKER} ${uniqueSuffix()}` }, ...a(), t);
    await sleep(1700);
    const checada = await nfse.checkInvoiceStatus(inv.id, ...a(), t);
    assert.equal(checada.status, 'REJECTED');
    const eventos = await nfse.getInvoiceEvents(inv.id, tenant.groupId, tenant.companyId, t);
    assert.ok(eventos.some((ev) => ev.rawStatus === 'REJECTED'));
    await assert.rejects(nfse.getInvoiceFile(inv.id, 'xml', tenant.groupId, tenant.companyId, t), codigo('NFSE_DOCUMENT_NOT_AVAILABLE'));

    const again = await nfse.checkInvoiceStatus(inv.id, ...a(), t);
    assert.equal(again.status, 'REJECTED', 'estado final não muda');
    const eventosDepois = await nfse.getInvoiceEvents(inv.id, tenant.groupId, tenant.companyId, t);
    assert.equal(eventosDepois.length, eventos.length, 'consultar de novo não cria evento');

    const nova = await nfse.requestInvoice({ sourceType: 'COMMISSION_ENTITLEMENT', sourceId: e.id, amount: Number(e.amount), description: `Nota corrigida ${uniqueSuffix()}` }, ...a(), t);
    assert.notEqual(nova.id, inv.id);
    assert.equal(nova.status, 'SUBMITTED');
  });
});

// ---------- DIMOB: locação ----------

async function locacao(t, { ano, locatarioDoc, comImovel }) {
  const locador = await pessoa(t, 'Locador', { taxIdNormalized: '12345678909' });
  const locatario = await pessoa(t, '=Locatário', locatarioDoc === undefined ? {} : { taxIdNormalized: locatarioDoc });
  const imovel = comImovel
    ? await Property.create({ ...ctx(), title: `Imóvel DIMOB ${uniqueSuffix()}`, internalCode: `DIM-${uniqueSuffix()}`, propertyType: 'HOUSE', createdBy: tenant.userId, updatedBy: tenant.userId }, { transaction: t })
    : null;
  const contrato = await Contract.create(
    { ...ctx(), contractType: 'LEASE_RESIDENTIAL', contractNumber: `DIM-${uniqueSuffix()}`, status: 'ACTIVE', propertyId: imovel ? imovel.id : null, createdBy: tenant.userId, updatedBy: tenant.userId },
    { transaction: t }
  );
  await ContractParty.create({ ...ctx(), contractId: contrato.id, personId: locador.id, partyRole: 'LANDLORD' }, { transaction: t });
  await ContractParty.create({ ...ctx(), contractId: contrato.id, personId: locatario.id, partyRole: 'TENANT' }, { transaction: t });
  for (const [mes, valor] of [['03', 1000], ['04', 1000.5]]) {
    await FinancialEntry.create(
      { ...ctx(), contractId: contrato.id, entryType: 'CREDIT', nature: 'RECEIVABLE', status: 'SETTLED', amount: valor, description: `Aluguel ${mes}/${ano}`, dueAt: new Date(Date.UTC(ano, Number(mes) - 1, 10)), settledAt: new Date(Date.UTC(ano, Number(mes) - 1, 10)), createdBy: tenant.userId, updatedBy: tenant.userId },
      { transaction: t }
    );
  }
  // fora do ano: não entra
  await FinancialEntry.create(
    { ...ctx(), contractId: contrato.id, entryType: 'CREDIT', nature: 'RECEIVABLE', status: 'SETTLED', amount: 777, description: 'Aluguel do ano seguinte', dueAt: new Date(Date.UTC(ano + 1, 0, 10)), settledAt: new Date(Date.UTC(ano + 1, 0, 10)), createdBy: tenant.userId, updatedBy: tenant.userId },
    { transaction: t }
  );
  return { contrato, locador, locatario, imovel };
}

test('M8-DIMOB-LOC-01: aluguel recebido no ano vira registro de locação; pendência de cadastro marca INVALID e impede fechar', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const ano = 2031;
    const { contrato } = await locacao(t, { ano, comImovel: false });
    const batch = await dimob.generateDimobBatch(ano, ...a().slice(0, 1), tenant.groupId, tenant.companyId, t);
    const { records } = await dimob.listDimobRecords(batch.id, tenant.groupId, tenant.companyId, t);
    const reg = records.find((r) => r.recordType === 'LEASE' && r.sourceRefs.contractId === contrato.id);
    assert.ok(reg);
    assert.equal(Number(reg.amount), 2000.5, 'só o que foi recebido dentro do ano');
    assert.equal(reg.validationStatus, 'INVALID');
    const codigos = reg.validationIssues.map((i) => i.code);
    assert.ok(codigos.includes('LOCATARIO_SEM_DOCUMENTO'));
    assert.ok(codigos.includes('IMOVEL_AUSENTE'));
    await assert.rejects(dimob.closeDimobBatch(batch.id, ...a(), t), codigo('DIMOB_BATCH_HAS_INVALID_RECORDS'));
  });
});

test('M8-DIMOB-LOC-02: contrato com cadastro completo fecha o batch, conclui a obrigação e a conferência bate', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const ano = 2032;
    const { contrato } = await locacao(t, { ano, locatarioDoc: '98765432100', comImovel: true });
    const batch = await dimob.generateDimobBatch(ano, ...a().slice(0, 1), tenant.groupId, tenant.companyId, t);
    const { records } = await dimob.listDimobRecords(batch.id, tenant.groupId, tenant.companyId, t);
    const reg = records.find((r) => r.sourceRefs.contractId === contrato.id);
    assert.equal(reg.validationStatus, 'VALID');
    assert.deepEqual(reg.validationIssues, []);
    const fechado = await dimob.closeDimobBatch(batch.id, ...a(), t);
    assert.equal(fechado.status, 'CLOSED');
    const abertas = (await recon.listReconciliations('OPEN', tenant.groupId, tenant.companyId, t)).filter((r) => r.referenceId === batch.id);
    assert.equal(abertas.length, 0, JSON.stringify(abertas));
  });
});

test('M8-DIMOB-LOC-03: arquivo de conferência traz layout, hash, documentos e neutraliza fórmula de planilha', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const ano = 2033;
    await locacao(t, { ano, comImovel: false });
    const batch = await dimob.generateDimobBatch(ano, ...a().slice(0, 1), tenant.groupId, tenant.companyId, t);
    const arquivo = await dimob.exportDimobFile(batch.id, ...a(), t);
    assert.equal(arquivo.fileName, `dimob-${ano}-v1.csv`);
    assert.match(arquivo.content, new RegExp(`^# layout;DIMOB-${ano}-v1;formato interno de conferência`));
    assert.equal(batch.layoutVersion, `DIMOB-${ano}-v1`);
    assert.match(arquivo.content, new RegExp(`hash;${batch.snapshotHash}`));
    assert.match(arquivo.content, /LOCACAO/);
    assert.match(arquivo.content, /12345678909/);
    assert.match(arquivo.content, /SEM DOCUMENTO/);
    assert.match(arquivo.content, /PENDENTE/);
    assert.match(arquivo.content, /"'=Locatário/, 'nome que começa com = é neutralizado');
    await assert.rejects(dimob.exportDimobFile('00000000-0000-0000-0000-000000000000', ...a(), t), codigo('DIMOB_BATCH_NOT_FOUND'));
  });
});

test('M8-DIMOB-LOC-04: o mesmo ano gera o mesmo hash (reprodutível) e o dataset ignora aluguel de outro ano', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const ano = 2034;
    await locacao(t, { ano, locatarioDoc: '98765432100', comImovel: true });
    const v1 = await dimob.generateDimobBatch(ano, ...a().slice(0, 1), tenant.groupId, tenant.companyId, t);
    const v2 = await dimob.generateDimobBatch(ano, ...a().slice(0, 1), tenant.groupId, tenant.companyId, t);
    assert.equal(v1.snapshotHash, v2.snapshotHash);
    assert.equal(v2.version, 2);
    const { records } = await dimob.listDimobRecords(v1.id, tenant.groupId, tenant.companyId, t);
    assert.equal(records.filter((r) => r.recordType === 'LEASE').length, 1);
    assert.equal(records.reduce((s, r) => s + Number(r.amount), 0), 2000.5);
  });
});

// ---------- Documentos enviados ao provider (uploadDocument) ----------

async function requisitoValidado(t, caso, documentType, { required = true, validar = true } = {}) {
  const requisito = await documentsService.createRequirement(caso.id, { documentType, required }, tenant.userId, ctx(), t);
  const arquivo = await File.create(
    { ...ctx(), fileName: `${documentType}-${uniqueSuffix()}.pdf`, mimeType: 'application/pdf', sizeBytes: 1024, storageKey: `test/${uniqueSuffix()}.pdf`, uploadedByUserId: tenant.userId },
    { transaction: t }
  );
  await documentsService.uploadDocument(caso.id, requisito.id, { fileId: arquivo.id }, tenant.userId, ctx(), t);
  if (validar) await documentsService.validateRequirement(caso.id, requisito.id, tenant.userId, ctx(), t, { manualFields: { taxId: '52998224725', name: 'Fulano de Tal', income: 5000, accountNumber: '12345-6' } });
  return requisito;
}

async function enviar(t, caso) {
  await simulationsService.createSimulation(caso.id, { amount: 150000, termMonths: 240 }, tenant.userId, tenant.groupId, tenant.companyId, t);
  return submissionsService.submitFinancingCase(caso.id, { consent: true }, tenant.userId, tenant.groupId, tenant.companyId, t);
}

test('M8-DOC-ENV-01: só o documento obrigatório e validado vai ao provider, uma vez, e fica marcado', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const caso = await novoCaso(t, await pessoa(t), { providerCode: 'sandbox' });
    const rg = await requisitoValidado(t, caso, 'RG_CPF');
    const opcional = await requisitoValidado(t, caso, 'IPTU', { required: false });
    const submissao = await enviar(t, caso);
    assert.equal(submissao.status, 'SUBMITTED');

    const docRg = await CaseDocument.findOne({ where: { requirementId: rg.id, supersededAt: null }, transaction: t });
    assert.ok(docRg.providerExternalDocumentId, 'documento obrigatório validado foi enviado');
    assert.ok(docRg.sentToProviderAt);
    const docOpc = await CaseDocument.findOne({ where: { requirementId: opcional.id, supersededAt: null }, transaction: t });
    assert.equal(docOpc.providerExternalDocumentId, null, 'documento fora do checklist obrigatório não vai');

    // Rodar de novo não reenvia o que já foi.
    const adapter = new SandboxFinancingProviderAdapter();
    const reenvio = await submissionsService.sendNeededDocuments(adapter, submissao, await FinancingCase.findByPk(caso.id, { transaction: t }), submissao.externalCaseId, tenant.userId, t);
    assert.equal(reenvio.length, 0);
  });
});

test('M8-DOC-ENV-02: provider manual não recebe documento; falha do provider vira erro de integração sem desfazer o envio do caso', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const manual = await novoCaso(t, await pessoa(t), { providerCode: 'manual' });
    await requisitoValidado(t, manual, 'RG_CPF');
    await submissionsService.submitFinancingCase(manual.id, { consent: true }, tenant.userId, tenant.groupId, tenant.companyId, t).catch(() => null);
    const enviadosManual = await CaseDocument.findAll({ where: { financingCaseId: manual.id }, transaction: t });
    assert.ok(enviadosManual.every((d) => !d.providerExternalDocumentId), 'manual não tem envio de documento');
  });

  await withRollbackTenantTransaction(tenant, async (t) => {
    const caso = await novoCaso(t, await pessoa(t), { providerCode: 'sandbox' });
    const rg = await requisitoValidado(t, caso, 'RG_CPF');
    const original = SandboxFinancingProviderAdapter.prototype.uploadDocument;
    SandboxFinancingProviderAdapter.prototype.uploadDocument = async () => { throw new Error('indisponível'); };
    let submissao;
    try {
      submissao = await enviar(t, caso);
    } finally {
      SandboxFinancingProviderAdapter.prototype.uploadDocument = original;
    }
    assert.equal(submissao.status, 'SUBMITTED', 'o envio do caso não é desfeito');
    const doc = await CaseDocument.findOne({ where: { requirementId: rg.id, supersededAt: null }, transaction: t });
    assert.equal(doc.providerExternalDocumentId, null, 'sem marca de enviado, fica para nova tentativa');
    const erros = await IntegrationError.findAll({ where: { financingCaseId: caso.id, operation: 'upload_document' }, transaction: t });
    assert.equal(erros.length, 1);
    assert.equal(erros[0].errorCode, 'DOCUMENT_UPLOAD_FAILED');
    assert.ok(!/indisponível/.test(erros[0].message), 'a mensagem da exceção não vaza');
  });
});

// ---------- Base da comissão ----------

test('M8-COM-BASE-01: sem valor-base usa o valor aprovado da proposta vigente; sem proposta recusa; valor informado prevalece', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const caso = await novoCaso(t, await pessoa(t));
    await assert.rejects(commissions.createCommissionEntitlement(caso.id, {}, tenant.userId, tenant.groupId, tenant.companyId, t), codigo('COMMISSION_ENTITLEMENT_VALIDATION'));

    await FinancingCase.update({ status: 'SUBMITTED' }, { where: { id: caso.id }, transaction: t });
    await workflow.registerManualStatus(caso.id, { status: 'APPROVED', proposal: { approvedAmount: 300000, annualRatePct: 10, termMonths: 360 } }, tenant.userId, tenant.groupId, tenant.companyId, t);

    const semBase = await commissions.createCommissionEntitlement(caso.id, {}, tenant.userId, tenant.groupId, tenant.companyId, t);
    assert.equal(Number(semBase.baseAmount), 300000);
    const comBase = await commissions.createCommissionEntitlement(caso.id, { baseAmount: 120000, triggerEvent: 'CONTRATO_ASSINADO' }, tenant.userId, tenant.groupId, tenant.companyId, t);
    assert.equal(Number(comBase.baseAmount), 120000);
    await assert.rejects(commissions.createCommissionEntitlement(caso.id, { baseAmount: -5 }, tenant.userId, tenant.groupId, tenant.companyId, t), codigo('COMMISSION_ENTITLEMENT_VALIDATION'));
  });
});

// ---------- Ajustes da auditoria do Claude Browser (25/10) ----------

test('M8-AUD-01: resumo da NAY mostra data válida da proposta e provider em português; base inválida tem mensagem sem nome de campo', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const caso = await novoCaso(t, await pessoa(t));
    await FinancingCase.update({ status: 'SUBMITTED' }, { where: { id: caso.id }, transaction: t });
    await workflow.registerManualStatus(caso.id, { status: 'APPROVED', proposal: { approvedAmount: 100000, annualRatePct: 9, termMonths: 120 } }, tenant.userId, tenant.groupId, tenant.companyId, t);
    const resumo = await nay.summarizeCase(caso.id, tenant.groupId, tenant.companyId, t);
    const texto = resumo.lines.map((l) => l.text).join(' ');
    assert.ok(!/Invalid Date/.test(texto), texto);
    assert.match(resumo.lines.find((l) => l.topic === 'Proposta do banco').text, /registrada em \d{2}\/\d{2}\/\d{4}/);
    assert.match(resumo.lines.find((l) => l.topic === 'Situação').text, /Manual \(conduzido com o banco/);
    await assert.rejects(
      commissions.createCommissionEntitlement(caso.id, { baseAmount: -1 }, tenant.userId, tenant.groupId, tenant.companyId, t),
      (err) => err.code === 'COMMISSION_ENTITLEMENT_VALIDATION' && !/baseAmount/.test(err.message)
    );
  });
});

test('M8-AUD-02: fila de duplicatas não lista caso já cancelado', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const principal = await pessoa(t);
    await novoCaso(t, principal);
    const segundo = await novoCaso(t, principal);
    assert.ok((await duplicates.listPendingDuplicateReviews(tenant.groupId, tenant.companyId, t)).some((c) => c.id === segundo.id));
    await workflow.cancelCase(segundo.id, { reason: 'Cliente desistiu' }, tenant.userId, tenant.groupId, tenant.companyId, t);
    assert.ok(!(await duplicates.listPendingDuplicateReviews(tenant.groupId, tenant.companyId, t)).some((c) => c.id === segundo.id));
  });
});

// ---------- Ajustes da segunda auditoria (25/10) ----------

test('M8-AUD-03: valor-base absurdo é recusado; cadastrar obrigação repetida avisa em vez de calar', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const caso = await novoCaso(t, await pessoa(t));
    await assert.rejects(
      commissions.createCommissionEntitlement(caso.id, { baseAmount: 100000100000 }, tenant.userId, tenant.groupId, tenant.companyId, t),
      (err) => err.code === 'COMMISSION_ENTITLEMENT_VALIDATION' && /alto demais/.test(err.message)
    );
    const obrigacoes = require('../../src/features/correspondent/fiscal/obligations.service');
    await sequelize.query('DELETE FROM correspondent.fiscal_obligations WHERE reference_year = 2099', { transaction: t });
    await obrigacoes.createObligation({ obligationType: 'DIMOB_ANNUAL', referenceYear: 2099 }, ...a(), t);
    await assert.rejects(obrigacoes.createObligation({ obligationType: 'DIMOB_ANNUAL', referenceYear: 2099 }, ...a(), t), codigo('FISCAL_OBLIGATION_ALREADY_EXISTS'));
  });
});

test('M8-AUD-04: a conferência conta todas as issues abertas e encerra a de versão antiga do DIMOB', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const ano = 2035;
    const v1 = await dimob.generateDimobBatch(ano, ...a().slice(0, 1), tenant.groupId, tenant.companyId, t);
    await recon.openReconciliation('DIMOB_X_CONTRACTS', v1.id, 100, 50, 50, tenant.userId, tenant.groupId, tenant.companyId, t);
    await dimob.generateDimobBatch(ano, ...a().slice(0, 1), tenant.groupId, tenant.companyId, t);
    const r = await recon.runReconciliations(tenant.userId, tenant.groupId, tenant.companyId, t);
    const aindaAberta = (await recon.listReconciliations('OPEN', tenant.groupId, tenant.companyId, t)).some((x) => x.referenceId === v1.id);
    assert.equal(aindaAberta, false, 'a issue da versão antiga foi encerrada');
    assert.equal(typeof r.openTotal, 'number');
    const abertas = await recon.listReconciliations('OPEN', tenant.groupId, tenant.companyId, t);
    assert.equal(r.openTotal, abertas.length);
  });
});

test('M8-AUD-05: a mesma identificação de confirmação não vale para duas comissões', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const e1 = await comissaoRecebivel(t);
    const caso = await novoCaso(t, await pessoa(t));
    const e2 = await commissions.createCommissionEntitlement(caso.id, { baseAmount: 1000 }, tenant.userId, tenant.groupId, tenant.companyId, t);
    await assert.rejects(
      commissions.confirmCommissionEntitlement(e2.id, { externalConfirmationId: e1.externalConfirmationId }, tenant.userId, tenant.groupId, tenant.companyId, t),
      codigo('COMMISSION_EXTERNAL_CONFIRMATION_ALREADY_USED')
    );
    // a mesma confirmação na mesma comissão continua idempotente
    const igual = await commissions.confirmCommissionEntitlement(e1.id, { externalConfirmationId: e1.externalConfirmationId }, tenant.userId, tenant.groupId, tenant.companyId, t);
    assert.equal(igual.id, e1.id);
  });
});
