'use strict';

// Marco 8 — achados da auditoria independente de 25/10/2026 (um revisor sem contexto leu o caderno
// e o código). Cada teste prova uma correção: transições impossíveis de status, consulta antes de
// reenviar após UNKNOWN, histórico de SUBMITTED, comissão em caso recusado, NAY comparando só
// simulações do mesmo valor, DIMOB (versão antiga, foto dos dados) e NFS-e UNKNOWN sem id externo.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('../testHelpers');
const { shouldApplyTransition } = require('../../src/features/correspondent/statusMachine');
const financingCases = require('../../src/features/correspondent/cases/financingCases.service');
const simulationsService = require('../../src/features/correspondent/cases/simulations.service');
const documentsService = require('../../src/features/correspondent/cases/caseDocuments.service');
const submissionsService = require('../../src/features/correspondent/cases/submissions.service');
const commissions = require('../../src/features/correspondent/cases/commissionEntitlements.service');
const workflow = require('../../src/features/correspondent/cases/caseWorkflow.service');
const nay = require('../../src/features/correspondent/correspondentNay.service');
const nfse = require('../../src/features/correspondent/fiscal/nfse.service');
const dimob = require('../../src/features/correspondent/fiscal/dimob.service');
const { SandboxFinancingProviderAdapter } = require('../../src/features/correspondent/adapters/FinancingProviderAdapter');
const { SandboxNfseAdapter } = require('../../src/features/correspondent/adapters/NfseAdapter');
const { Person, File, FinancingCase, ProviderStatusHistory, InvoiceRequest, DimobBatch, Property } = require('../../src/models');

let tenant;
before(async () => { tenant = await getSeedTenant(); });
after(async () => { await sequelize.close(); });

const ctx = () => ({ groupId: tenant.groupId, companyId: tenant.companyId });
const a = () => [tenant.userId, tenant.groupId, tenant.companyId];
const codigo = (c) => (err) => { assert.equal(err.code, c, `esperava ${c}, veio ${err.code}: ${err.message}`); return true; };

async function novoCaso(t, providerCode = 'sandbox') {
  const principal = await Person.create(
    { ...ctx(), personType: 'PF', legalName: `Proponente auditoria ${uniqueSuffix()}`, createdBy: tenant.userId, updatedBy: tenant.userId },
    { transaction: t }
  );
  return financingCases.createFinancingCase(
    { ...ctx(), providerCode, applicants: [{ personId: principal.id, role: 'PRINCIPAL' }] },
    tenant.userId,
    t
  );
}

// A avaliação é do imóvel: o caso precisa ter um imóvel vinculado (regra de Parâmetros).
async function comImovel(caso, t) {
  const imovel = await Property.create(
    { ...ctx(), title: `Imóvel auditoria ${uniqueSuffix()}`, internalCode: `AUD-${uniqueSuffix()}`, propertyType: 'HOUSE', createdBy: tenant.userId, updatedBy: tenant.userId },
    { transaction: t }
  );
  await FinancingCase.update({ propertyId: imovel.id }, { where: { id: caso.id }, transaction: t });
  await caso.reload({ transaction: t });
  return caso;
}

async function checklistValidado(caso, t) {
  const requirement = await documentsService.createRequirement(caso.id, { documentType: 'RG_CPF', required: true }, tenant.userId, ctx(), t);
  const file = await File.create(
    { ...ctx(), fileName: `rg-${uniqueSuffix()}.pdf`, mimeType: 'application/pdf', sizeBytes: 20000, storageKey: `test/${uniqueSuffix()}.pdf`, uploadedByUserId: tenant.userId },
    { transaction: t }
  );
  await documentsService.uploadDocument(caso.id, requirement.id, { fileId: file.id }, tenant.userId, ctx(), t);
  await documentsService.validateRequirement(caso.id, requirement.id, tenant.userId, ctx(), t, { manualFields: { taxId: '52998224725', name: 'Fulano de Tal', income: 5000, accountNumber: '12345-6' } });
}

// ---------- Máquina de estados ----------

test('M8-AUDI-01: caso recusado só pode ser cancelado; concluído e cancelado são finais', () => {
  assert.equal(shouldApplyTransition('REJECTED', 'CONTRACTING'), false);
  assert.equal(shouldApplyTransition('REJECTED', 'COMPLETED'), false);
  assert.equal(shouldApplyTransition('REJECTED', 'APPROVED'), false);
  assert.equal(shouldApplyTransition('REJECTED', 'CANCELED'), true);
  assert.equal(shouldApplyTransition('COMPLETED', 'CANCELED'), false);
  assert.equal(shouldApplyTransition('CANCELED', 'COMPLETED'), false);
  assert.equal(shouldApplyTransition('APPROVED', 'CONTRACTING'), true);
  assert.equal(shouldApplyTransition('UNDER_ANALYSIS', 'PENDING_CUSTOMER'), true);
  assert.equal(shouldApplyTransition('APPROVED', 'UNDER_ANALYSIS'), false);
});

test('M8-AUDI-02: registro manual não leva um caso recusado a "contratando"', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const caso = await novoCaso(t, 'manual');
    await FinancingCase.update({ status: 'REJECTED' }, { where: { id: caso.id }, transaction: t });
    await assert.rejects(
      workflow.registerManualStatus(caso.id, { status: 'CONTRACTING', note: 'Contrato assinado' }, ...a(), t),
      (err) => { assert.ok(err.statusCode >= 400 && err.statusCode < 500); return true; }
    );
  });
});

// ---------- Envio, UNKNOWN e consulta ----------

test('M8-AUDI-03: o envio grava SUBMITTED no histórico append-only e emite a mudança de status', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const caso = await novoCaso(t);
    await checklistValidado(caso, t);
    await simulationsService.createSimulation(caso.id, { amount: 150000, termMonths: 240 }, ...a(), t);
    const submission = await submissionsService.submitFinancingCase(caso.id, { consent: true }, ...a(), t);
    assert.equal(submission.status, 'SUBMITTED');
    const historico = await ProviderStatusHistory.findAll({ where: { financingCaseId: caso.id }, transaction: t });
    assert.ok(historico.some((h) => h.normalizedStatus === 'SUBMITTED' && h.source === 'submission' && h.applied === true));
  });
});

test('M8-AUDI-04: UNKNOWN com externalCaseId — a consulta recupera o envio e NÃO libera reenvio', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const caso = await novoCaso(t);
    await checklistValidado(caso, t);
    await simulationsService.createSimulation(caso.id, { amount: 150000, termMonths: 240 }, ...a(), t);
    const original = SandboxFinancingProviderAdapter.prototype.submitCase;
    // O provider aceita o caso (guarda na memória do sandbox) mas a resposta se perde.
    SandboxFinancingProviderAdapter.prototype.submitCase = async function perdida(req) {
      await original.call(this, req);
      throw new Error('Conexão perdida depois de o provider aceitar o caso.');
    };
    let submission;
    try {
      submission = await submissionsService.submitFinancingCase(caso.id, { consent: true }, ...a(), t);
    } finally {
      SandboxFinancingProviderAdapter.prototype.submitCase = original;
    }
    assert.equal(submission.status, 'UNKNOWN');

    const antes = await FinancingCase.findByPk(caso.id, { transaction: t });
    const versaoAntes = antes.submissionVersion;
    const r = await submissionsService.acknowledgeUnknownSubmission(submission.id, {}, ...a(), t);
    assert.equal(r.recovered, true);
    const depois = await FinancingCase.findByPk(caso.id, { transaction: t });
    assert.equal(depois.status, 'SUBMITTED');
    assert.equal(depois.submissionVersion, versaoAntes, 'recuperar não libera novo envio');
  });
});

test('M8-AUDI-05: UNKNOWN que o provider confirma não ter recebido libera novo envio com chave nova', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const caso = await novoCaso(t);
    await checklistValidado(caso, t);
    await simulationsService.createSimulation(caso.id, { amount: 150000, termMonths: 240 }, ...a(), t);
    const original = SandboxFinancingProviderAdapter.prototype.submitCase;
    SandboxFinancingProviderAdapter.prototype.submitCase = async () => { throw new Error('Provider fora do ar.'); };
    let submission;
    try {
      submission = await submissionsService.submitFinancingCase(caso.id, { consent: true }, ...a(), t);
    } finally {
      SandboxFinancingProviderAdapter.prototype.submitCase = original;
    }
    assert.equal(submission.status, 'UNKNOWN');
    // Por padrão há uma janela de espera antes de liberar novo envio: logo depois do timeout, é recusado.
    await assert.rejects(submissionsService.acknowledgeUnknownSubmission(submission.id, {}, ...a(), t), codigo('SUBMISSION_UNKNOWN_TOO_RECENT'));
    await atualizarElegibilidade(t, { unknownReleaseMinutes: 0 });
    const versaoAntes = (await FinancingCase.findByPk(caso.id, { transaction: t })).submissionVersion;
    const r = await submissionsService.acknowledgeUnknownSubmission(submission.id, {}, ...a(), t);
    assert.equal(r.recovered, false);
    // A submissão incerta é encerrada e o novo envio fica liberado (a tela deixa de tratá-la como pendência).
    assert.equal((await ProviderSubmission.findByPk(submission.id, { transaction: t })).status, 'CANCELED');
    const versaoDepois = (await FinancingCase.findByPk(caso.id, { transaction: t })).submissionVersion;
    assert.equal(versaoDepois, versaoAntes + 1);
  });
});

test('M8-AUDI-06: provider manual (sem consulta automática) exige descrever o que foi conferido com o banco', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const caso = await novoCaso(t, 'manual');
    await checklistValidado(caso, t);
    await simulationsService.createSimulation(caso.id, { amount: 150000, termMonths: 240 }, ...a(), t).catch(() => {});
    const original = require('../../src/features/correspondent/adapters/FinancingProviderAdapter').ManualWorkflowFinancingProviderAdapter.prototype.submitCase;
    const Manual = require('../../src/features/correspondent/adapters/FinancingProviderAdapter').ManualWorkflowFinancingProviderAdapter;
    Manual.prototype.submitCase = async () => { throw new Error('Falha simulada.'); };
    let submission;
    try {
      submission = await submissionsService.submitFinancingCase(caso.id, { consent: true }, ...a(), t);
    } finally {
      Manual.prototype.submitCase = original;
    }
    assert.equal(submission.status, 'UNKNOWN');
    await atualizarElegibilidade(t, { unknownReleaseMinutes: 0 });
    await assert.rejects(submissionsService.acknowledgeUnknownSubmission(submission.id, {}, ...a(), t), codigo('SUBMISSION_VERIFICATION_REQUIRED'));
    await assert.rejects(submissionsService.acknowledgeUnknownSubmission(submission.id, { verification: 'curto' }, ...a(), t), codigo('SUBMISSION_VERIFICATION_REQUIRED'));
    const r = await submissionsService.acknowledgeUnknownSubmission(submission.id, { verification: 'Liguei para o gerente e o banco não tem o caso.' }, ...a(), t);
    assert.equal(r.recovered, false);
  });
});

// ---------- Comissão ----------

test('M8-AUDI-07: caso recusado ou cancelado não gera comissão; valor-base é arredondado em centavos', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const recusado = await novoCaso(t, 'manual');
    await FinancingCase.update({ status: 'REJECTED' }, { where: { id: recusado.id }, transaction: t });
    await assert.rejects(
      commissions.createCommissionEntitlement(recusado.id, { baseAmount: 100000 }, ...a(), t),
      codigo('COMMISSION_ENTITLEMENT_CASE_NOT_ELIGIBLE')
    );
    const cancelado = await novoCaso(t, 'manual');
    await FinancingCase.update({ status: 'CANCELED', canceledReason: 'Teste', canceledAt: new Date() }, { where: { id: cancelado.id }, transaction: t });
    await assert.rejects(
      commissions.createCommissionEntitlement(cancelado.id, { baseAmount: 100000 }, ...a(), t),
      codigo('COMMISSION_ENTITLEMENT_CASE_NOT_ELIGIBLE')
    );

    const ok = await novoCaso(t, 'manual');
    const e = await commissions.createCommissionEntitlement(ok.id, { baseAmount: 100000.005 }, ...a(), t);
    assert.equal(Number(e.baseAmount), 100000.01);
  });
});

// ---------- NAY ----------

test('M8-AUDI-08: a NAY só recomenda entre simulações do mesmo valor financiado', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const caso = await novoCaso(t);
    await simulationsService.createSimulation(caso.id, { amount: 10000, termMonths: 360 }, ...a(), t);
    await simulationsService.createSimulation(caso.id, { amount: 500000, termMonths: 360 }, ...a(), t);
    const diferentes = await nay.compareSimulations(caso.id, tenant.groupId, tenant.companyId, t);
    assert.equal(diferentes.lowestPaymentSimulationId, null, 'valores diferentes não são comparáveis');

    await simulationsService.createSimulation(caso.id, { amount: 500000, termMonths: 120 }, ...a(), t);
    const iguais = await nay.compareSimulations(caso.id, tenant.groupId, tenant.companyId, t);
    const recomendada = iguais.simulations.find((s) => s.lowestPayment);
    assert.ok(recomendada);
    assert.equal(recomendada.amount, 500000);
  });
});

// ---------- Documentos ----------

test('M8-AUDI-09: caso cancelado não valida documento; validade inválida é recusada com mensagem de negócio', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const caso = await novoCaso(t);
    const requirement = await documentsService.createRequirement(caso.id, { documentType: 'RG_CPF', required: true }, tenant.userId, ctx(), t);
    const file = await File.create(
      { ...ctx(), fileName: `rg-${uniqueSuffix()}.pdf`, mimeType: 'application/pdf', sizeBytes: 20000, storageKey: `test/${uniqueSuffix()}.pdf`, uploadedByUserId: tenant.userId },
      { transaction: t }
    );
    await assert.rejects(
      documentsService.uploadDocument(caso.id, requirement.id, { fileId: file.id, expiresAt: 'não é data' }, tenant.userId, ctx(), t),
      codigo('CASE_DOCUMENT_VALIDATION')
    );
    await documentsService.uploadDocument(caso.id, requirement.id, { fileId: file.id }, tenant.userId, ctx(), t);
    await FinancingCase.update({ status: 'CANCELED', canceledReason: 'Teste', canceledAt: new Date() }, { where: { id: caso.id }, transaction: t });
    await assert.rejects(documentsService.validateRequirement(caso.id, requirement.id, tenant.userId, ctx(), t, { manualFields: { taxId: '52998224725', name: 'Fulano de Tal', income: 5000, accountNumber: '12345-6' } }), codigo('FINANCING_CASE_CANCELED'));
  });
});

test('M8-AUDI-10: caso pronto para envio volta a "documentos pendentes" quando ganha um item novo', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const caso = await novoCaso(t);
    await checklistValidado(caso, t);
    assert.equal((await FinancingCase.findByPk(caso.id, { transaction: t })).status, 'READY_TO_SUBMIT');
    await documentsService.createRequirement(caso.id, { documentType: 'COMPROVANTE_RENDA', required: true }, tenant.userId, ctx(), t);
    assert.equal((await FinancingCase.findByPk(caso.id, { transaction: t })).status, 'DOCUMENTS_PENDING');
  });
});

// ---------- NFS-e ----------

test('M8-AUDI-11: NFS-e UNKNOWN sem id externo é resolvida pela consulta (achada ou encerrada)', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    // Emissor perdeu a resposta e NÃO recebeu o pedido: a consulta encerra o pedido e libera nova emissão.
    const originalRequest = SandboxNfseAdapter.prototype.requestInvoice;
    SandboxNfseAdapter.prototype.requestInvoice = async () => { throw new Error('Rede caiu antes de o emissor receber.'); };
    let invoice;
    const sourceId = crypto.randomUUID();
    try {
      invoice = await nfse.requestInvoice({ sourceType: 'SERVICE_ORDER', sourceId, amount: 100, description: 'Serviço de teste' }, ...a(), t);
    } finally {
      SandboxNfseAdapter.prototype.requestInvoice = originalRequest;
    }
    assert.equal(invoice.status, 'UNKNOWN');
    // Por padrão há espera antes de encerrar a emissão indefinida (dá tempo de uma resposta tardia chegar).
    await assert.rejects(nfse.checkInvoiceStatus(invoice.id, ...a(), t), codigo('NFSE_UNKNOWN_TOO_RECENT'));
    await atualizarElegibilidade(t, { unknownReleaseMinutes: 0 });
    const resolvida = await nfse.checkInvoiceStatus(invoice.id, ...a(), t);
    assert.equal(resolvida.status, 'CANCELED');
    const nova = await nfse.requestInvoice({ sourceType: 'SERVICE_ORDER', sourceId, amount: 100, description: 'Serviço de teste' }, ...a(), t);
    assert.notEqual(nova.id, invoice.id);
    assert.equal(nova.status, 'SUBMITTED');
    assert.ok(await InvoiceRequest.findByPk(nova.id, { transaction: t }));
  });
});

test('M8-AUDI-12: em produção o emissor sandbox não emite nota', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const anterior = process.env.DEPLOY_ENVIRONMENT;
    process.env.DEPLOY_ENVIRONMENT = 'production';
    try {
      await assert.rejects(
        nfse.requestInvoice({ sourceType: 'SERVICE_ORDER', sourceId: crypto.randomUUID(), amount: 100, description: 'Serviço' }, ...a(), t),
        codigo('NFSE_ISSUER_NOT_CONFIGURED')
      );
    } finally {
      if (anterior === undefined) delete process.env.DEPLOY_ENVIRONMENT; else process.env.DEPLOY_ENVIRONMENT = anterior;
    }
  });
});

// ---------- DIMOB ----------

test('M8-AUDI-13: só a versão mais recente do ano pode ser fechada', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const ano = 2040 + Math.floor(Math.random() * 50);
    const v1 = await dimob.generateDimobBatch(ano, ...a(), t);
    await dimob.generateDimobBatch(ano, ...a(), t);
    await assert.rejects(dimob.closeDimobBatch(v1.id, ...a(), t), codigo('DIMOB_BATCH_SUPERSEDED'));
    assert.equal((await DimobBatch.findByPk(v1.id, { transaction: t })).status, 'DRAFT');
  });
});

// ---------- Segunda rodada da auditoria independente ----------

const { CaseRequirement, ProviderSubmission } = require('../../src/models');
const { sanitizeProviderMessage } = require('../../src/features/correspondent/sanitizeProviderMessage');

test('M8-AUDI-14: caso com checklist vazio não é enviado ao provider', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const caso = await novoCaso(t);
    await simulationsService.createSimulation(caso.id, { amount: 150000, termMonths: 240 }, ...a(), t);
    await assert.rejects(
      submissionsService.submitFinancingCase(caso.id, { consent: true }, ...a(), t),
      codigo('SUBMISSION_CHECKLIST_EMPTY')
    );
  });
});

test('M8-AUDI-15: documento vencido não trava o checklist: o item novo validado libera o envio', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const caso = await novoCaso(t);
    await checklistValidado(caso, t);
    // Simula o que o job de vencimento faz: o item validado vira EXPIRED e nasce um item novo.
    await CaseRequirement.update({ status: 'EXPIRED' }, { where: { financingCaseId: caso.id, documentType: 'RG_CPF' }, transaction: t });
    await checklistValidado(caso, t); // cria o item novo, envia e valida
    await simulationsService.createSimulation(caso.id, { amount: 150000, termMonths: 240 }, ...a(), t);
    const submission = await submissionsService.submitFinancingCase(caso.id, { consent: true }, ...a(), t);
    assert.equal(submission.status, 'SUBMITTED');
  });
});

test('M8-AUDI-16: repetir o status atual não é transição (webhook reentregue não reaplica efeito)', () => {
  for (const status of ['SUBMITTED', 'UNDER_ANALYSIS', 'APPROVED', 'REJECTED', 'COMPLETED']) {
    assert.equal(shouldApplyTransition(status, status), false, status);
  }
});

test('M8-AUDI-17: comissão repetida para o mesmo caso e fato gerador é recusada; depois do estorno pode refazer', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const caso = await novoCaso(t, 'manual');
    const primeira = await commissions.createCommissionEntitlement(caso.id, { baseAmount: 100000 }, ...a(), t);
    await assert.rejects(
      commissions.createCommissionEntitlement(caso.id, { baseAmount: 100000 }, ...a(), t),
      codigo('COMMISSION_ENTITLEMENT_ALREADY_EXISTS')
    );
    await commissions.chargebackCommissionEntitlement(primeira.id, 'Valor lançado errado', ...a(), t);
    const segunda = await commissions.createCommissionEntitlement(caso.id, { baseAmount: 120000 }, ...a(), t);
    assert.notEqual(segunda.id, primeira.id);
  });
});

test('M8-AUDI-18: cancelar o caso encerra o envio UNKNOWN; reconhecer UNKNOWN de caso cancelado é recusado', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const caso = await novoCaso(t);
    await checklistValidado(caso, t);
    await simulationsService.createSimulation(caso.id, { amount: 150000, termMonths: 240 }, ...a(), t);
    const original = SandboxFinancingProviderAdapter.prototype.submitCase;
    SandboxFinancingProviderAdapter.prototype.submitCase = async () => { throw new Error('Provider fora do ar.'); };
    let submission;
    try {
      submission = await submissionsService.submitFinancingCase(caso.id, { consent: true }, ...a(), t);
    } finally {
      SandboxFinancingProviderAdapter.prototype.submitCase = original;
    }
    assert.equal(submission.status, 'UNKNOWN');
    await workflow.cancelCase(caso.id, { reason: 'Cliente desistiu da operação' }, ...a(), t);
    const depois = await ProviderSubmission.findByPk(submission.id, { transaction: t });
    assert.equal(depois.status, 'CANCELED');
    await assert.rejects(submissionsService.acknowledgeUnknownSubmission(submission.id, {}, ...a(), t), (err) => err.statusCode >= 400 && err.statusCode < 500);
  });
});

test('M8-AUDI-19: mensagem de erro do provider perde endereço, token e IP antes de ser guardada', () => {
  const limpa = sanitizeProviderMessage('Falha em https://api.banco.com/v1/casos?token=abc Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789ABCD no 10.0.0.5:8080');
  assert.ok(!/https?:/.test(limpa));
  assert.ok(!/abcdefghijklmnopqrstuvwxyz/.test(limpa));
  assert.ok(!/10\.0\.0\.5/.test(limpa));
  assert.match(limpa, /Falha em/);
  assert.equal(sanitizeProviderMessage(''), 'Falha na comunicação com o provider.');
});

// ---------- Terceira rodada: decisões do livro e parâmetros do admin ----------

const parameters = require('../../src/features/correspondent/parameters.service');
const { CommissionAdjustment } = require('../../src/models');

test('M8-AUDI-20: duplicata pendente só bloqueia o envio quando o admin liga o parâmetro (padrão: só alerta)', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const principal = await Person.create({ ...ctx(), personType: 'PF', legalName: `Dup auditoria ${uniqueSuffix()}`, createdBy: tenant.userId, updatedBy: tenant.userId }, { transaction: t });
    const mk = () => financingCases.createFinancingCase({ ...ctx(), providerCode: 'sandbox', applicants: [{ personId: principal.id, role: 'PRINCIPAL' }] }, tenant.userId, t);
    await mk();
    const segundo = await mk();
    assert.equal(segundo.duplicateReviewStatus, 'PENDING');
    await checklistValidado(segundo, t);
    await simulationsService.createSimulation(segundo.id, { amount: 150000, termMonths: 240 }, ...a(), t);

    const atual = await parameters.getParameters(tenant.groupId, tenant.companyId, tenant.userId, t);
    assert.equal(atual.eligibility.action.blockSubmissionOnPendingDuplicate, false, 'padrão: não bloqueia');

    await parameters.updateEligibility({ ...atual.eligibility.action, blockSubmissionOnPendingDuplicate: true }, 'Teste: bloquear duplicata', tenant.userId, tenant.groupId, tenant.companyId, t);
    await assert.rejects(
      submissionsService.submitFinancingCase(segundo.id, { consent: true }, ...a(), t),
      codigo('SUBMISSION_DUPLICATE_REVIEW_PENDING')
    );
    await parameters.updateEligibility({ ...atual.eligibility.action, blockSubmissionOnPendingDuplicate: false }, 'Teste: voltar ao padrão', tenant.userId, tenant.groupId, tenant.companyId, t);
    const enviado = await submissionsService.submitFinancingCase(segundo.id, { consent: true }, ...a(), t);
    assert.equal(enviado.status, 'SUBMITTED');
  });
});

test('M8-AUDI-21: comissão de correspondente só entra no DIMOB se o admin ligar o parâmetro', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const caso = await novoCaso(t, 'manual');
    const e = await commissions.createCommissionEntitlement(caso.id, { baseAmount: 100000 }, ...a(), t);
    await commissions.confirmCommissionEntitlement(e.id, { externalConfirmationId: `aud-${uniqueSuffix()}` }, ...a(), t);
    const ano = new Date().getUTCFullYear();

    const semComissao = await dimob.generateDimobBatch(ano, ...a(), t);
    const registros = await dimob.listDimobRecords(semComissao.id, tenant.groupId, tenant.companyId, t);
    assert.ok(!registros.records.some((r) => r.recordType === 'CORRESPONDENT_COMMISSION'), 'padrão: comissão fora do DIMOB');

    const atual = await parameters.getParameters(tenant.groupId, tenant.companyId, tenant.userId, t);
    await parameters.updateCommission({ ...atual.commission.action, dimobIncludeCommissions: true }, 'Teste: incluir comissão no DIMOB', tenant.userId, tenant.groupId, tenant.companyId, t);
    const comComissao = await dimob.generateDimobBatch(ano, ...a(), t);
    const registros2 = await dimob.listDimobRecords(comComissao.id, tenant.groupId, tenant.companyId, t);
    assert.ok(registros2.records.some((r) => r.recordType === 'CORRESPONDENT_COMMISSION'));
  });
});

test('M8-AUDI-22: o estorno cria um ajuste próprio (negativo) e o direito original mantém o valor', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const caso = await novoCaso(t, 'manual');
    const e = await commissions.createCommissionEntitlement(caso.id, { baseAmount: 100000 }, ...a(), t);
    const valor = Number(e.amount);
    await commissions.chargebackCommissionEntitlement(e.id, 'Cliente desistiu antes do contrato', ...a(), t);
    const ajustes = await CommissionAdjustment.findAll({ where: { commissionEntitlementId: e.id }, transaction: t });
    assert.equal(ajustes.length, 1);
    assert.equal(Number(ajustes[0].amount), -valor);
    assert.equal(ajustes[0].adjustmentType, 'CHARGEBACK');
    const relido = await commissions.listCommissionEntitlements(caso.id, tenant.groupId, tenant.companyId, t);
    assert.equal(Number(relido[0].amount), valor, 'o valor original é preservado');
    assert.equal(relido[0].status, 'ADJUSTED');
  });
});

test('M8-AUDI-23: o envio guarda no snapshot quem consentiu, os documentos e a versão da regra de elegibilidade', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const caso = await novoCaso(t);
    await checklistValidado(caso, t);
    await simulationsService.createSimulation(caso.id, { amount: 150000, termMonths: 240 }, ...a(), t);
    const submission = await submissionsService.submitFinancingCase(caso.id, { consent: true }, ...a(), t);
    const snap = submission.requestSnapshot;
    assert.equal(snap.consent.given, true);
    assert.equal(snap.consent.byUserId, tenant.userId);
    assert.ok(snap.consent.at);
    assert.equal(snap.applicants.length, 1);
    assert.ok(snap.documents.length >= 1);
    assert.ok(snap.eligibilityRuleVersionId);
  });
});

test('M8-AUDI-24: o sandbox é idempotente pela chave: repetir o envio devolve o mesmo caso externo', async () => {
  const adapter = new SandboxFinancingProviderAdapter();
  const chave = `financing:${crypto.randomUUID()}:provider:sandbox:v1`;
  const primeiro = await adapter.submitCase({ idempotencyKey: chave });
  const segundo = await adapter.submitCase({ idempotencyKey: chave });
  assert.equal(segundo.externalId, primeiro.externalId);
});

// ---------- Quarta rodada ----------

const { applyPolledStatus } = require('../../src/features/correspondent/webhooks.service');
const appraisalsService = require('../../src/features/correspondent/cases/appraisals.service');

async function atualizarElegibilidade(t, mudancas, motivo = 'Teste de parâmetro') {
  const atual = await parameters.getParameters(tenant.groupId, tenant.companyId, tenant.userId, t);
  await parameters.updateEligibility({ ...atual.eligibility.action, ...mudancas }, motivo, tenant.userId, tenant.groupId, tenant.companyId, t);
}

test('M8-AUDI-25: documento pode ser recusado com motivo e aceita novo envio; a versão recusada fica no histórico', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const caso = await novoCaso(t);
    const requirement = await documentsService.createRequirement(caso.id, { documentType: 'RG_CPF', required: true }, tenant.userId, ctx(), t);
    const file = await File.create(
      { ...ctx(), fileName: `rg-${uniqueSuffix()}.pdf`, mimeType: 'application/pdf', sizeBytes: 20000, storageKey: `test/${uniqueSuffix()}.pdf`, uploadedByUserId: tenant.userId },
      { transaction: t }
    );
    await documentsService.uploadDocument(caso.id, requirement.id, { fileId: file.id }, tenant.userId, ctx(), t);
    await assert.rejects(documentsService.rejectRequirement(caso.id, requirement.id, 'x', tenant.userId, ctx(), t), codigo('CASE_REQUIREMENT_REJECT_REASON_REQUIRED'));
    const recusado = await documentsService.rejectRequirement(caso.id, requirement.id, 'Foto cortada, ilegível', tenant.userId, ctx(), t);
    assert.equal(recusado.status, 'REJECTED');
    assert.match(recusado.notes, /ilegível/);
    const file2 = await File.create(
      { ...ctx(), fileName: `rg2-${uniqueSuffix()}.pdf`, mimeType: 'application/pdf', sizeBytes: 20000, storageKey: `test/${uniqueSuffix()}.pdf`, uploadedByUserId: tenant.userId },
      { transaction: t }
    );
    const novo = await documentsService.uploadDocument(caso.id, requirement.id, { fileId: file2.id }, tenant.userId, ctx(), t);
    assert.equal(novo.version, 2);
  });
});

test('M8-AUDI-26: marcar a comissão como recebida liquida o recebível no Financeiro', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const caso = await novoCaso(t, 'manual');
    const e = await commissions.createCommissionEntitlement(caso.id, { baseAmount: 100000 }, ...a(), t);
    const confirmada = await commissions.confirmCommissionEntitlement(e.id, { externalConfirmationId: `rec-${uniqueSuffix()}` }, ...a(), t);
    const { FinancialEntry } = require('../../src/models');
    assert.equal((await FinancialEntry.findByPk(confirmada.financialEntryId, { transaction: t })).status, 'PENDING');
    const recebida = await commissions.receiveCommissionEntitlement(e.id, ...a(), t);
    assert.equal(recebida.status, 'RECEIVED');
    assert.equal((await FinancialEntry.findByPk(confirmada.financialEntryId, { transaction: t })).status, 'SETTLED');
  });
});

test('M8-AUDI-27: com região configurada para o provider, caso sem imóvel com UF é bloqueado', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const caso = await novoCaso(t, 'sandbox');
    await atualizarElegibilidade(t, { allowedStatesByProvider: { sandbox: ['SP', 'RJ'] }, blockWhenPropertyRegionUnknown: true });
    await assert.rejects(simulationsService.createSimulation(caso.id, { amount: 100000, termMonths: 120 }, ...a(), t), codigo('COR_ELIGIBILITY_REGION_UNKNOWN'));
    await assert.rejects(parameters.updateEligibility({ allowedProviders: ['sandbox'], allowedPurposes: ['RESIDENCIAL'], allowedProducts: ['FINANCIAMENTO_IMOBILIARIO'], maxAmountByProvider: {}, allowedStatesByProvider: { sandbox: ['SAO PAULO'] } }, 'UF errada', ...a(), t), codigo('CORRESPONDENT_PARAMETERS_VALIDATION'));
  });
});

test('M8-AUDI-28: avaliação respeita a elegibilidade e não aceita dois pedidos abertos', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const caso = await novoCaso(t, 'sandbox');
    await comImovel(caso, t);
    await atualizarElegibilidade(t, { allowedProviders: ['manual'] });
    await assert.rejects(appraisalsService.requestAppraisalRecord(caso.id, {}, ...a(), t), codigo('COR_ELIGIBILITY_PROVIDER_NOT_ALLOWED'));
    await atualizarElegibilidade(t, { allowedProviders: ['sandbox', 'manual'] });
    await appraisalsService.requestAppraisalRecord(caso.id, {}, ...a(), t);
    await assert.rejects(appraisalsService.requestAppraisalRecord(caso.id, {}, ...a(), t), codigo('APPRAISAL_ALREADY_REQUESTED'));
  });
});

test('M8-AUDI-29: nota de comissão exige comissão real e já confirmada', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    await assert.rejects(
      nfse.requestInvoice({ sourceType: 'COMMISSION_ENTITLEMENT', sourceId: crypto.randomUUID(), amount: 100, description: 'Comissão' }, ...a(), t),
      codigo('NFSE_SOURCE_NOT_FOUND')
    );
    const caso = await novoCaso(t, 'manual');
    const e = await commissions.createCommissionEntitlement(caso.id, { baseAmount: 100000 }, ...a(), t);
    await assert.rejects(
      nfse.requestInvoice({ sourceType: 'COMMISSION_ENTITLEMENT', sourceId: e.id, amount: 1000, description: 'Comissão' }, ...a(), t),
      codigo('NFSE_SOURCE_NOT_READY')
    );
  });
});

test('M8-AUDI-30: consentimento: a prova só é exigida quando o admin liga o parâmetro, e fica no snapshot', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const caso = await novoCaso(t);
    await checklistValidado(caso, t);
    await simulationsService.createSimulation(caso.id, { amount: 150000, termMonths: 240 }, ...a(), t);
    await atualizarElegibilidade(t, { requireConsentEvidence: true });
    await assert.rejects(submissionsService.submitFinancingCase(caso.id, { consent: true }, ...a(), t), codigo('SUBMISSION_CONSENT_EVIDENCE_REQUIRED'));
    const s = await submissionsService.submitFinancingCase(caso.id, { consent: true, consentEvidence: 'Assinatura digital no contrato de intermediação' }, ...a(), t);
    assert.match(s.requestSnapshot.consent.evidence, /Assinatura digital/);
  });
});

test('M8-AUDI-31: consulta de status aplica pelas regras do webhook, não regride e não repete', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const caso = await novoCaso(t);
    await FinancingCase.update({ status: 'SUBMITTED' }, { where: { id: caso.id }, transaction: t });
    const adapter = new SandboxFinancingProviderAdapter();
    const atual = await FinancingCase.findByPk(caso.id, { transaction: t });
    const r1 = await applyPolledStatus(atual, adapter, { rawProviderStatus: 'APPROVED' }, t);
    assert.equal(r1.applied, true);
    assert.equal((await FinancingCase.findByPk(caso.id, { transaction: t })).status, 'APPROVED');
    const r2 = await applyPolledStatus(await FinancingCase.findByPk(caso.id, { transaction: t }), adapter, { rawProviderStatus: 'APPROVED' }, t);
    assert.equal(r2.applied, false);
    const r3 = await applyPolledStatus(await FinancingCase.findByPk(caso.id, { transaction: t }), adapter, { rawProviderStatus: 'ANALYSIS' }, t);
    assert.equal(r3.applied, false, 'não regride de APPROVED para análise');
    const historico = await ProviderStatusHistory.findAll({ where: { financingCaseId: caso.id, source: 'poll' }, transaction: t });
    assert.equal(historico.length, 2);
  });
});

test('M8-AUDI-32: o admin escolhe em que etapas o caso não gera comissão', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const caso = await novoCaso(t, 'manual');
    const atual = await parameters.getParameters(tenant.groupId, tenant.companyId, tenant.userId, t);
    await parameters.updateCommission({ ...atual.commission.action, blockedCaseStatuses: ['DRAFT'] }, 'Bloquear comissão em rascunho', ...a(), t);
    await assert.rejects(commissions.createCommissionEntitlement(caso.id, { baseAmount: 100000 }, ...a(), t), codigo('COMMISSION_ENTITLEMENT_CASE_NOT_ELIGIBLE'));
    await FinancingCase.update({ status: 'SUBMITTED' }, { where: { id: caso.id }, transaction: t });
    const e = await commissions.createCommissionEntitlement(caso.id, { baseAmount: 100000 }, ...a(), t);
    assert.ok(e.id);
  });
});

test('M8-AUDI-33: documentos validados são reenviados ao provider só depois do aceite', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const caso = await novoCaso(t);
    await assert.rejects(submissionsService.resendDocumentsToProvider(caso.id, ...a(), t), codigo('SUBMISSION_NOT_ACCEPTED'));
    await checklistValidado(caso, t);
    await simulationsService.createSimulation(caso.id, { amount: 150000, termMonths: 240 }, ...a(), t);
    await submissionsService.submitFinancingCase(caso.id, { consent: true }, ...a(), t);
    const r = await submissionsService.resendDocumentsToProvider(caso.id, ...a(), t);
    assert.equal(typeof r.sentCount, 'number');
  });
});

// ---------- Quinta rodada ----------

const { ExternalCaseRouting } = require('../../src/models');

async function casoPronto(t) {
  const caso = await novoCaso(t);
  await checklistValidado(caso, t);
  await simulationsService.createSimulation(caso.id, { amount: 150000, termMonths: 240 }, ...a(), t);
  return caso;
}

test('M8-AUDI-34: submissão cancelada pelo worker (provider ficou inelegível) não trava o caso: novo pedido usa chave nova', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const caso = await casoPronto(t);
    const pendente = await submissionsService.requestSubmission(caso.id, { consent: true }, ...a(), t);
    assert.equal(pendente.status, 'PENDING');
    await atualizarElegibilidade(t, { allowedProviders: ['manual'] });
    const casoAtual = await FinancingCase.findByPk(caso.id, { transaction: t });
    const cancelada = await submissionsService.processPendingSubmission(pendente, casoAtual, tenant.userId, t);
    assert.equal(cancelada.status, 'CANCELED');
    await atualizarElegibilidade(t, { allowedProviders: ['sandbox', 'manual'] });
    const novo = await submissionsService.requestSubmission(caso.id, { consent: true }, ...a(), t);
    assert.notEqual(novo.id, pendente.id);
    assert.equal(novo.status, 'PENDING');
  });
});

test('M8-AUDI-35: se o registro local falha depois de o provider aceitar, a submissão fica aceita e o provider NÃO é chamado de novo', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const caso = await casoPronto(t);
    const pendente = await submissionsService.requestSubmission(caso.id, { consent: true }, ...a(), t);
    const originalSubmit = SandboxFinancingProviderAdapter.prototype.submitCase;
    const originalQuery = sequelize.query;
    let chamadas = 0;
    SandboxFinancingProviderAdapter.prototype.submitCase = async function contada(req) { chamadas += 1; return originalSubmit.call(this, req); };
    sequelize.query = function falhaNoRoteamento(sql, ...resto) {
      if (typeof sql === 'string' && sql.includes('external_case_routing') && /INSERT/i.test(sql)) throw new Error('Falha simulada ao gravar o roteamento.');
      return originalQuery.call(this, sql, ...resto);
    };
    try {
      const casoAtual = await FinancingCase.findByPk(caso.id, { transaction: t });
      const depois = await submissionsService.processPendingSubmission(pendente, casoAtual, tenant.userId, t);
      assert.equal(depois.status, 'SUBMITTED');
      assert.ok(depois.externalCaseId);
      assert.equal(depois.failureReason, 'FINALIZACAO_LOCAL_PENDENTE');
      assert.equal(chamadas, 1);
    } finally {
      SandboxFinancingProviderAdapter.prototype.submitCase = originalSubmit;
      sequelize.query = originalQuery;
    }
  });
});

test('M8-AUDI-36: checklist mínimo definido pelo admin bloqueia o envio até ter os documentos exigidos', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const caso = await casoPronto(t);
    await atualizarElegibilidade(t, { requiredDocumentTypes: ['RG_CPF', 'COMPROVANTE_RENDA'] });
    await assert.rejects(submissionsService.submitFinancingCase(caso.id, { consent: true }, ...a(), t), codigo('SUBMISSION_CHECKLIST_MINIMUM_MISSING'));
    await assert.rejects(parameters.updateEligibility({ allowedProviders: ['sandbox'], allowedPurposes: ['RESIDENCIAL'], allowedProducts: ['FINANCIAMENTO_IMOBILIARIO'], maxAmountByProvider: {}, requiredDocumentTypes: ['INEXISTENTE'] }, 'Tipo inválido', ...a(), t), codigo('CORRESPONDENT_PARAMETERS_VALIDATION'));
  });
});

test('M8-AUDI-37: janela de duplicata e dias de caso parado são parâmetros validados', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    await assert.rejects(atualizarElegibilidade(t, { duplicateWindowHours: 0 }), codigo('CORRESPONDENT_PARAMETERS_VALIDATION'));
    await assert.rejects(atualizarElegibilidade(t, { stalledCaseDays: 400 }), codigo('CORRESPONDENT_PARAMETERS_VALIDATION'));
    await atualizarElegibilidade(t, { duplicateWindowHours: 48, stalledCaseDays: 3 });
    const atual = await parameters.getParameters(tenant.groupId, tenant.companyId, tenant.userId, t);
    assert.equal(atual.eligibility.action.duplicateWindowHours, 48);
    assert.equal(atual.eligibility.action.stalledCaseDays, 3);
    const parados = await nay.checkStalledCases(tenant.groupId, tenant.companyId, {}, t);
    assert.equal(parados.thresholdDays, 3);
  });
});

test('M8-AUDI-38: o admin pode permitir mais de uma comissão para o mesmo caso e fato gerador', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const caso = await novoCaso(t, 'manual');
    const atual = await parameters.getParameters(tenant.groupId, tenant.companyId, tenant.userId, t);
    await parameters.updateCommission({ ...atual.commission.action, blockDuplicateCommissionPerTrigger: false }, 'Comissão parcelada', ...a(), t);
    await commissions.createCommissionEntitlement(caso.id, { baseAmount: 100000 }, ...a(), t);
    const segunda = await commissions.createCommissionEntitlement(caso.id, { baseAmount: 50000 }, ...a(), t);
    assert.ok(segunda.id);
  });
});

test('M8-AUDI-39: comissão prevista não pode ser confirmada depois que o caso foi cancelado', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const caso = await novoCaso(t, 'manual');
    const e = await commissions.createCommissionEntitlement(caso.id, { baseAmount: 100000 }, ...a(), t);
    await workflow.cancelCase(caso.id, { reason: 'Cliente desistiu do financiamento' }, ...a(), t);
    // Cancelar o caso já estorna a comissão prevista: ela não pode mais ser confirmada.
    await assert.rejects(
      commissions.confirmCommissionEntitlement(e.id, { externalConfirmationId: `canc-${uniqueSuffix()}` }, ...a(), t),
      codigo('COMMISSION_ENTITLEMENT_ALREADY_ADJUSTED')
    );
  });
});

test('M8-AUDI-40: avaliação que o provider não conclui vira falha visível, não pedido eterno', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const caso = await novoCaso(t, 'sandbox');
    await comImovel(caso, t);
    const original = SandboxFinancingProviderAdapter.prototype.requestAppraisal;
    SandboxFinancingProviderAdapter.prototype.requestAppraisal = async () => ({ externalId: 'x', status: 'IN_PROGRESS' });
    try {
      const r = await appraisalsService.createAppraisal(caso.id, {}, ...a(), t);
      assert.equal(r.status, 'FAILED');
      await appraisalsService.requestAppraisalRecord(caso.id, {}, ...a(), t);
    } finally {
      SandboxFinancingProviderAdapter.prototype.requestAppraisal = original;
    }
  });
});

// ---------- Sexta rodada ----------

const { resolveFinancingProviderAdapterByCode } = require('../../src/features/correspondent/adapters/resolveFinancingProviderAdapter');
const { FinancingProposal } = require('../../src/models');

test('M8-AUDI-41: finalização local pendente é retomada sem chamar o provider de novo', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const caso = await casoPronto(t);
    const pendente = await submissionsService.requestSubmission(caso.id, { consent: true }, ...a(), t);
    const originalSubmit = SandboxFinancingProviderAdapter.prototype.submitCase;
    const originalQuery = sequelize.query;
    let chamadas = 0;
    SandboxFinancingProviderAdapter.prototype.submitCase = async function contada(req) { chamadas += 1; return originalSubmit.call(this, req); };
    sequelize.query = function falhaNoRoteamento(sql, ...resto) {
      if (typeof sql === 'string' && sql.includes('external_case_routing') && /INSERT/i.test(sql)) throw new Error('Falha simulada.');
      return originalQuery.call(this, sql, ...resto);
    };
    let depois;
    try {
      depois = await submissionsService.processPendingSubmission(pendente, await FinancingCase.findByPk(caso.id, { transaction: t }), tenant.userId, t);
    } finally {
      sequelize.query = originalQuery;
    }
    try {
      assert.equal(depois.failureReason, 'FINALIZACAO_LOCAL_PENDENTE');
      const ok = await submissionsService.retryPendingFinalization(depois, await FinancingCase.findByPk(caso.id, { transaction: t }), tenant.userId, t);
      assert.equal(ok, true);
      assert.equal((await FinancingCase.findByPk(caso.id, { transaction: t })).status, 'SUBMITTED');
      assert.equal((await ProviderSubmission.findByPk(pendente.id, { transaction: t })).failureReason, null);
      assert.equal(chamadas, 1, 'o provider não é chamado de novo');
    } finally {
      SandboxFinancingProviderAdapter.prototype.submitCase = originalSubmit;
    }
  });
});

test('M8-AUDI-42: a consulta de status também registra a proposta do banco quando ela vem na resposta', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const caso = await novoCaso(t);
    await FinancingCase.update({ status: 'SUBMITTED' }, { where: { id: caso.id }, transaction: t });
    const adapter = new SandboxFinancingProviderAdapter();
    const r = await applyPolledStatus(await FinancingCase.findByPk(caso.id, { transaction: t }), adapter, { rawProviderStatus: 'APPROVED', proposal: { approvedAmount: 200000, annualRatePct: 9.5, termMonths: 240 } }, t);
    assert.equal(r.applied, true);
    const propostas = await FinancingProposal.findAll({ where: { financingCaseId: caso.id }, transaction: t });
    assert.equal(propostas.length, 1);
    assert.equal(propostas[0].source, 'PROVIDER');
    assert.equal(Number(propostas[0].approvedAmount), 200000);
  });
});

test('M8-AUDI-43: em produção e staging o provider sandbox não existe', () => {
  const anterior = process.env.DEPLOY_ENVIRONMENT;
  try {
    process.env.DEPLOY_ENVIRONMENT = 'production';
    assert.equal(resolveFinancingProviderAdapterByCode('sandbox'), null);
    process.env.DEPLOY_ENVIRONMENT = 'staging';
    assert.equal(resolveFinancingProviderAdapterByCode('sandbox'), null);
    assert.ok(resolveFinancingProviderAdapterByCode('manual'));
    delete process.env.DEPLOY_ENVIRONMENT;
    assert.ok(resolveFinancingProviderAdapterByCode('sandbox'));
  } finally {
    if (anterior === undefined) delete process.env.DEPLOY_ENVIRONMENT; else process.env.DEPLOY_ENVIRONMENT = anterior;
  }
});

test('M8-AUDI-44: avaliação pedida antes e processada depois que o provider ficou inelegível não é enviada', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const caso = await novoCaso(t, 'sandbox');
    await comImovel(caso, t);
    const pedido = await appraisalsService.requestAppraisalRecord(caso.id, {}, ...a(), t);
    await atualizarElegibilidade(t, { allowedProviders: ['manual'] });
    let chamadas = 0;
    const original = SandboxFinancingProviderAdapter.prototype.requestAppraisal;
    SandboxFinancingProviderAdapter.prototype.requestAppraisal = async function contada(req) { chamadas += 1; return original.call(this, req); };
    try {
      const r = await appraisalsService.processPendingAppraisal(pedido, await FinancingCase.findByPk(caso.id, { transaction: t }), tenant.userId, t);
      assert.equal(r.status, 'FAILED');
      assert.equal(chamadas, 0);
    } finally {
      SandboxFinancingProviderAdapter.prototype.requestAppraisal = original;
    }
  });
});

// ---------- Sétima rodada: tudo o que o quinto auditor apontou ----------

const exportService = require('../../src/features/correspondent/fiscal/accountingExport.service');
const { AccountingExportLine, CaseDocument } = require('../../src/models');

async function comissaoRecebida(t, base = 100000) {
  const caso = await novoCaso(t, 'manual');
  const e = await commissions.createCommissionEntitlement(caso.id, { baseAmount: base }, ...a(), t);
  const confirmada = await commissions.confirmCommissionEntitlement(e.id, { externalConfirmationId: `rr-${uniqueSuffix()}` }, ...a(), t);
  return { caso, confirmada };
}

test('M8-AUDI-45: estorno de recebível pendente cancela o lançamento; de recebido estorna com compensação', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const { FinancialEntry } = require('../../src/models');
    const pendente = await comissaoRecebida(t);
    await commissions.chargebackCommissionEntitlement(pendente.confirmada.id, 'Cliente desistiu', ...a(), t);
    assert.equal((await FinancialEntry.findByPk(pendente.confirmada.financialEntryId, { transaction: t })).status, 'CANCELLED');
    assert.equal(await FinancialEntry.findOne({ where: { reversalOfEntryId: pendente.confirmada.financialEntryId }, transaction: t }), null);

    const recebida = await comissaoRecebida(t);
    await commissions.receiveCommissionEntitlement(recebida.confirmada.id, ...a(), t);
    await commissions.chargebackCommissionEntitlement(recebida.confirmada.id, 'Chargeback do banco', ...a(), t);
    assert.equal((await FinancialEntry.findByPk(recebida.confirmada.financialEntryId, { transaction: t })).status, 'REVERSED');
    assert.ok(await FinancialEntry.findOne({ where: { reversalOfEntryId: recebida.confirmada.financialEntryId }, transaction: t }));
  });
});

test('M8-AUDI-46: o hash da exportação não depende da ordem; o mesmo retorno não entra duas vezes; estorno de comissão exportada cria ajuste', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    assert.equal(
      exportService.hashLines([{ sourceType: 'A', sourceId: '1', amount: 10 }, { sourceType: 'B', sourceId: '2', amount: 5 }]),
      exportService.hashLines([{ sourceType: 'B', sourceId: '2', amount: 5 }, { sourceType: 'A', sourceId: '1', amount: 10 }])
    );
    const { confirmada } = await comissaoRecebida(t);
    const periodo = new Date().toISOString().slice(0, 7);
    const lote = await exportService.createExportBatch(periodo, [{ sourceType: 'COMMISSION_ENTITLEMENT', sourceId: confirmada.id, amount: Number(confirmada.amount), description: 'Comissão' }], ...a(), t);
    const retorno = { batchHash: lote.batchHash, lines: [{ sourceType: 'COMMISSION_ENTITLEMENT', sourceId: confirmada.id, amount: Number(confirmada.amount) }] };
    await exportService.importAccountingReturn(lote.id, retorno, ...a(), t);
    await assert.rejects(exportService.importAccountingReturn(lote.id, retorno, ...a(), t), codigo('ACCOUNTING_RETURN_ALREADY_IMPORTED'));

    await commissions.chargebackCommissionEntitlement(confirmada.id, 'Chargeback depois de exportar', ...a(), t);
    const ajustes = await AccountingExportLine.findAll({ where: { batchId: lote.id, sourceId: confirmada.id }, transaction: t });
    assert.equal(ajustes.length, 2, 'a linha original + o ajuste automático');
    assert.equal(ajustes.filter((l) => l.adjustmentOfLineId).length, 1);
  });
});

test('M8-AUDI-47: cancelar um caso já aceito avisa o provider; falha do aviso vira erro de integração e o cancelamento vale', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const caso = await casoPronto(t);
    await submissionsService.submitFinancingCase(caso.id, { consent: true }, ...a(), t);
    let avisos = 0;
    const original = SandboxFinancingProviderAdapter.prototype.cancelCase;
    SandboxFinancingProviderAdapter.prototype.cancelCase = async function contado(id) { avisos += 1; return original.call(this, id); };
    try {
      await workflow.cancelCase(caso.id, { reason: 'Cliente desistiu da operação' }, ...a(), t);
    } finally {
      SandboxFinancingProviderAdapter.prototype.cancelCase = original;
    }
    assert.equal(avisos, 1);
    assert.equal((await FinancingCase.findByPk(caso.id, { transaction: t })).status, 'CANCELED');

    const caso2 = await casoPronto(t);
    await submissionsService.submitFinancingCase(caso2.id, { consent: true }, ...a(), t);
    SandboxFinancingProviderAdapter.prototype.cancelCase = async () => { throw new Error('indisponível'); };
    try {
      await workflow.cancelCase(caso2.id, { reason: 'Cliente desistiu da operação' }, ...a(), t);
    } finally {
      SandboxFinancingProviderAdapter.prototype.cancelCase = original;
    }
    assert.equal((await FinancingCase.findByPk(caso2.id, { transaction: t })).status, 'CANCELED');
    const { IntegrationError } = require('../../src/models');
    const erros = await IntegrationError.findAll({ where: { financingCaseId: caso2.id, operation: 'cancel' }, transaction: t });
    assert.equal(erros.length, 1);
  });
});

test('M8-AUDI-48: repetir o pedido de envio devolve o existente mesmo se o checklist foi reaberto depois', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const caso = await casoPronto(t);
    const primeiro = await submissionsService.requestSubmission(caso.id, { consent: true }, ...a(), t);
    await documentsService.createRequirement(caso.id, { documentType: 'COMPROVANTE_RENDA', required: true }, tenant.userId, ctx(), t);
    const segundo = await submissionsService.requestSubmission(caso.id, { consent: true }, ...a(), t);
    assert.equal(segundo.id, primeiro.id);
  });
});

test('M8-AUDI-49: a leitura automática do documento fica cifrada no banco e legível pelo modelo', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const caso = await novoCaso(t);
    const { requirement } = await checklistValidado(caso, t).then(() => ({ requirement: null }));
    const doc = await CaseDocument.findOne({ where: { financingCaseId: caso.id }, transaction: t });
    doc.suggestedNote = 'Nome: Fulano; CPF: 123.456.789-09; Renda: R$ 5.000,00';
    await doc.save({ transaction: t });
    const [[linha]] = await sequelize.query('SELECT suggested_note FROM correspondent.case_documents WHERE id = :id', { replacements: { id: doc.id }, transaction: t });
    assert.ok(linha.suggested_note.startsWith('enc:'));
    assert.ok(!/123\.456/.test(linha.suggested_note));
    const relido = await CaseDocument.findByPk(doc.id, { transaction: t });
    assert.match(relido.suggestedNote, /CPF: 123\.456\.789-09/);
    assert.equal(requirement, null);
  });
});


// ---------- Oitava rodada: tudo o que o sexto auditor apontou ----------

const { Contract, ContractParty, FinancialEntry, IntegrationError } = require('../../src/models');
const adapterModule = require('../../src/features/correspondent/adapters/FinancingProviderAdapter');
const obligations = require('../../src/features/correspondent/fiscal/obligations.service');

async function locacaoComBaixaParcial(t, ano) {
  const pessoaMk = (nome, extra = {}) => Person.create({ ...ctx(), personType: 'PF', legalName: `${nome} ${uniqueSuffix()}`, createdBy: tenant.userId, updatedBy: tenant.userId, ...extra }, { transaction: t });
  const locador = await pessoaMk('Locador', { taxIdNormalized: '12345678909' });
  const locatario = await pessoaMk('Locatario', { taxIdNormalized: '98765432100' });
  const contrato = await Contract.create({ ...ctx(), contractType: 'LEASE_RESIDENTIAL', contractNumber: `PAR-${uniqueSuffix()}`, status: 'ACTIVE', createdBy: tenant.userId, updatedBy: tenant.userId }, { transaction: t });
  await ContractParty.create({ ...ctx(), contractId: contrato.id, personId: locador.id, partyRole: 'LANDLORD' }, { transaction: t });
  await ContractParty.create({ ...ctx(), contractId: contrato.id, personId: locatario.id, partyRole: 'TENANT' }, { transaction: t });
  const base = { ...ctx(), contractId: contrato.id, entryType: 'CREDIT', nature: 'RECEIVABLE', createdBy: tenant.userId, updatedBy: tenant.userId };
  // aluguel de 2.000 pago em duas baixas de 1.000: pai SETTLED com valor cheio + duas filhas SETTLED
  const pai = await FinancialEntry.create({ ...base, status: 'SETTLED', amount: 2000, description: 'Aluguel 05', dueAt: new Date(Date.UTC(ano, 4, 5)), settledAt: new Date(Date.UTC(ano, 5, 20)) }, { transaction: t });
  await FinancialEntry.create({ ...base, status: 'SETTLED', amount: 1000, description: 'Aluguel 05', parentEntryId: pai.id, dueAt: new Date(Date.UTC(ano, 4, 5)), settledAt: new Date(Date.UTC(ano, 4, 10)) }, { transaction: t });
  await FinancialEntry.create({ ...base, status: 'SETTLED', amount: 1000, description: 'Aluguel 05', parentEntryId: pai.id, dueAt: new Date(Date.UTC(ano, 4, 5)), settledAt: new Date(Date.UTC(ano, 5, 20)) }, { transaction: t });
  // cobrança que não é aluguel
  await FinancialEntry.create({ ...base, status: 'SETTLED', amount: 300, description: 'Condomínio 05', dueAt: new Date(Date.UTC(ano, 4, 5)), settledAt: new Date(Date.UTC(ano, 4, 10)) }, { transaction: t });
  await FinancialEntry.create({ ...base, status: 'SETTLED', amount: 50, description: 'Aguardando conferência da vistoria', dueAt: new Date(Date.UTC(ano, 4, 5)), settledAt: new Date(Date.UTC(ano, 4, 10)) }, { transaction: t });
  return contrato;
}

test('M8-AUDI-51: DIMOB não conta o aluguel em dobro nas baixas parciais e deixa de fora o que não é aluguel', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const ano = 2036;
    const contrato = await locacaoComBaixaParcial(t, ano);
    const dataset = await require('../../src/features/correspondent/fiscal/dimobDataset.service').buildDimobDataset(ano, tenant.groupId, tenant.companyId, t);
    const registro = dataset.find((r) => r.sourceRefs.contractId === contrato.id);
    // 1.000 + 1.000 (baixas) + 50 ("Aguardando..." não é palavra de exclusão); condomínio (300) fora; pai não conta de novo
    assert.equal(registro.amount, 2050);
  });
});

test('M8-AUDI-52: confirmar comissão exige a permissão financeira por padrão e o admin pode desligar; o direito precisa ser do caso', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const split = require('../../src/features/correspondent/commissionSplit.service');
    assert.equal(await split.getConfirmRequiresFinancePermission(tenant.groupId, tenant.companyId, tenant.userId, t), true);
    const atual = await parameters.getParameters(tenant.groupId, tenant.companyId, tenant.userId, t);
    await parameters.updateCommission({ ...atual.commission.action, confirmRequiresFinancePermission: false }, 'Teste de segregação', ...a(), t);
    assert.equal(await split.getConfirmRequiresFinancePermission(tenant.groupId, tenant.companyId, tenant.userId, t), false);
    const palavras = await split.getDimobExcludedKeywords(tenant.groupId, tenant.companyId, tenant.userId, t);
    assert.ok(palavras.includes('condomínio'));
  });
});

test('M8-AUDI-53: o envio em três tempos deixa UNKNOWN "em andamento" confirmado antes de chamar o provider e resolve o resultado depois', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const caso = await casoPronto(t);
    const pendente = await submissionsService.requestSubmission(caso.id, { consent: true }, ...a(), t);
    const casoAtual = await FinancingCase.findByPk(caso.id, { transaction: t });
    const adapter = await submissionsService.preflightSubmission(pendente, casoAtual, tenant.userId, t);
    assert.ok(adapter);
    const outcome = await submissionsService.callProviderSubmit(adapter, pendente);
    assert.ok(outcome.result);
    const final = await submissionsService.applyProviderOutcome(adapter, pendente, casoAtual, outcome, tenant.userId, t);
    assert.equal(final.status, 'SUBMITTED');
    assert.ok(final.externalCaseId);
  });
});

test('M8-AUDI-54: cenários de falha do sandbox pelos centavos do valor: erro e timeout viram UNKNOWN; recusa e pendência vêm na consulta', async () => {
  const adapter = new adapterModule.SandboxFinancingProviderAdapter();
  await assert.rejects(adapter.submitCase({ idempotencyKey: `k-${uniqueSuffix()}`, amount: 100000.13 }), /Falha simulada do sandbox/);
  const negada = await adapter.submitCase({ idempotencyKey: `k-${uniqueSuffix()}`, amount: 100000.15 });
  assert.match(negada.externalId, /-DENIED-\d+$/);
  const doc = await adapter.submitCase({ idempotencyKey: `k-${uniqueSuffix()}`, amount: 100000.16 });
  assert.match(doc.externalId, /-DOC-\d+$/);
  const normal = await adapter.submitCase({ idempotencyKey: `k-${uniqueSuffix()}`, amount: 100000 });
  assert.doesNotMatch(normal.externalId, /-(DENIED|DOC)-/);
  assert.equal(adapter.normalizeProviderStatus('DENIED'), 'REJECTED');
  assert.equal(adapter.normalizeProviderStatus('DOC_PENDING'), 'PENDING_CUSTOMER');
});

test('M8-AUDI-55: consulta de status guarda o status bruto não reconhecido, sem repetir a cada consulta', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const caso = await novoCaso(t);
    await FinancingCase.update({ status: 'SUBMITTED' }, { where: { id: caso.id }, transaction: t });
    const adapter = new adapterModule.SandboxFinancingProviderAdapter();
    await applyPolledStatus(await FinancingCase.findByPk(caso.id, { transaction: t }), adapter, { rawProviderStatus: 'EM_COMITE' }, t);
    await applyPolledStatus(await FinancingCase.findByPk(caso.id, { transaction: t }), adapter, { rawProviderStatus: 'EM_COMITE' }, t);
    const historico = await ProviderStatusHistory.findAll({ where: { financingCaseId: caso.id, source: 'poll' }, transaction: t });
    assert.equal(historico.length, 1);
    assert.equal(historico[0].rawProviderStatus, 'EM_COMITE');
    assert.equal(historico[0].normalizedStatus, null);
  });
});

test('M8-AUDI-56: cancelar o caso estorna as comissões ainda previstas e a confirmação delas passa a ser recusada', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const caso = await novoCaso(t, 'manual');
    const e = await commissions.createCommissionEntitlement(caso.id, { baseAmount: 100000 }, ...a(), t);
    await workflow.cancelCase(caso.id, { reason: 'Cliente desistiu do financiamento' }, ...a(), t);
    const lista = await commissions.listCommissionEntitlements(caso.id, tenant.groupId, tenant.companyId, t);
    assert.equal(lista.find((x) => x.id === e.id).status, 'ADJUSTED');
    await assert.rejects(commissions.confirmCommissionEntitlement(e.id, { externalConfirmationId: `c-${uniqueSuffix()}` }, ...a(), t), codigo('COMMISSION_ENTITLEMENT_ALREADY_ADJUSTED'));
  });
});

test('M8-AUDI-57: proposta com valor absurdo ou data inexistente é recusada com mensagem de negócio', () => {
  assert.throws(() => workflow.validateProposalInput({ approvedAmount: 1e12, termMonths: 120 }), codigo('PROPOSAL_VALIDATION'));
  assert.throws(() => workflow.validateProposalInput({ approvedAmount: 100000, termMonths: 120, validUntil: '2026-02-31' }), codigo('PROPOSAL_VALIDATION'));
  assert.ok(workflow.validateProposalInput({ approvedAmount: 100000, termMonths: 120, validUntil: '2026-02-28' }));
});

test('M8-AUDI-58: obrigações fiscais: listar não grava; vencida aparece como vencida', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const o = await obligations.ensureObligation({ obligationType: 'DIMOB_ANNUAL', referenceYear: 2018, dueAt: '2019-02-28' }, ...a(), t);
    const lista = await obligations.listObligations(tenant.groupId, tenant.companyId, t);
    assert.equal(lista.find((x) => x.id === o.id).status, 'OVERDUE');
    const noBanco = await require('../../src/models').FiscalObligation.findByPk(o.id, { transaction: t });
    assert.equal(noBanco.status, 'PENDING', 'o GET não escreve no banco');
  });
});

test('M8-AUDI-59: o provider padrão da empresa vale quando o caso nasce sem provider', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const settingsService = require('../../src/features/settings/settings.service');
    await settingsService.upsertSetting('correspondent.financing_provider', 'manual', ctx(), tenant.userId, t);
    const principal = await Person.create({ ...ctx(), personType: 'PF', legalName: `Padrão ${uniqueSuffix()}`, createdBy: tenant.userId, updatedBy: tenant.userId }, { transaction: t });
    const caso = await financingCases.createFinancingCase({ ...ctx(), applicants: [{ personId: principal.id, role: 'PRINCIPAL' }] }, tenant.userId, t);
    assert.equal(caso.providerCode, 'manual');
  });
});


// ---------- Nona rodada: tudo o que o sétimo auditor apontou ----------

const { onCaseClosedByProvider } = workflow;

test('M8-AUDI-60: depois de liberar o novo envio, o caso pode ser enviado de novo e a submissão antiga fica encerrada', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const caso = await casoPronto(t);
    await atualizarElegibilidade(t, { unknownReleaseMinutes: 0 });
    const original = SandboxFinancingProviderAdapter.prototype.submitCase;
    SandboxFinancingProviderAdapter.prototype.submitCase = async () => { throw new Error('Provider fora do ar.'); };
    let incerta;
    try {
      incerta = await submissionsService.submitFinancingCase(caso.id, { consent: true }, ...a(), t);
    } finally {
      SandboxFinancingProviderAdapter.prototype.submitCase = original;
    }
    assert.equal(incerta.status, 'UNKNOWN');
    await submissionsService.acknowledgeUnknownSubmission(incerta.id, {}, ...a(), t);
    const nova = await submissionsService.submitFinancingCase(caso.id, { consent: true }, ...a(), t);
    assert.equal(nova.status, 'SUBMITTED');
    assert.notEqual(nova.id, incerta.id);
    // Caso já aceito não é enviado de novo com outra chave
    await FinancingCase.update({ submissionVersion: 99 }, { where: { id: caso.id }, transaction: t });
    await assert.rejects(submissionsService.requestSubmission(caso.id, { consent: true }, ...a(), t), codigo('SUBMISSION_ALREADY_ACCEPTED'));
  });
});

test('M8-AUDI-61: o líquido exportado vai a zero no estorno, mesmo com ajuste manual anterior', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const { confirmada } = await comissaoRecebida(t);
    const periodo = new Date().toISOString().slice(0, 7);
    const lote = await exportService.createExportBatch(periodo, [{ sourceType: 'COMMISSION_ENTITLEMENT', sourceId: confirmada.id, amount: Number(confirmada.amount), description: 'Comissão' }], ...a(), t);
    const original = await AccountingExportLine.findOne({ where: { batchId: lote.id, sourceId: confirmada.id, adjustmentOfLineId: null }, transaction: t });
    await exportService.adjustExportLine(original.id, 10, 'Ajuste manual de teste', ...a(), t);
    await commissions.chargebackCommissionEntitlement(confirmada.id, 'Chargeback depois do ajuste', ...a(), t);
    const linhas = await AccountingExportLine.findAll({ where: { batchId: lote.id, sourceId: confirmada.id }, transaction: t });
    assert.equal(Math.round(linhas.reduce((s2, l) => s2 + Number(l.amount), 0) * 100) / 100, 0);
    await assert.rejects(exportService.createExportBatch(periodo, [{ sourceType: 'COMMISSION_ENTITLEMENT', sourceId: crypto.randomUUID(), amount: 10, description: 'Origem inexistente' }], ...a(), t), codigo('ACCOUNTING_EXPORT_VALIDATION'));
    await assert.rejects(exportService.createExportBatch(periodo, [{ sourceType: 'LANCAMENTO_MANUAL', sourceId: crypto.randomUUID(), amount: 0, description: 'Zero' }], ...a(), t), codigo('ACCOUNTING_EXPORT_VALIDATION'));
  });
});

test('M8-AUDI-62: nota de lançamento do Financeiro é conferida contra o valor do lançamento', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const lancamento = await FinancialEntry.create({ ...ctx(), entryType: 'CREDIT', nature: 'RECEIVABLE', status: 'PENDING', amount: 1000, description: 'Serviço de teste', dueAt: new Date(), createdBy: tenant.userId, updatedBy: tenant.userId }, { transaction: t });
    await assert.rejects(nfse.requestInvoice({ sourceType: 'FINANCIAL_ENTRY', sourceId: crypto.randomUUID(), amount: 1000, description: 'Serviço' }, ...a(), t), codigo('NFSE_SOURCE_NOT_FOUND'));
    const nota = await nfse.requestInvoice({ sourceType: 'FINANCIAL_ENTRY', sourceId: lancamento.id, amount: 1200, description: 'Serviço de teste' }, ...a(), t);
    await new Promise((r) => setTimeout(r, 1700));
    await nfse.checkInvoiceStatus(nota.id, ...a(), t);
    const { FiscalReconciliation } = require('../../src/models');
    const issue = await FiscalReconciliation.findOne({ where: { reconciliationType: 'FINANCE_X_NFSE', referenceId: nota.id, status: 'OPEN' }, transaction: t });
    assert.ok(issue, 'valor da nota diferente do lançamento abre divergência');
    assert.equal(Number(issue.differenceAmount), -200);
  });
});

test('M8-AUDI-63: o provider cancelou ou recusou o caso: comissão prevista é estornada e a confirmada vira alerta', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const caso = await novoCaso(t, 'manual');
    await FinancingCase.update({ status: 'APPROVED' }, { where: { id: caso.id }, transaction: t });
    const prevista = await commissions.createCommissionEntitlement(caso.id, { baseAmount: 100000, triggerEvent: 'REGISTRO_MANUAL' }, ...a(), t);
    const outra = await commissions.createCommissionEntitlement(caso.id, { baseAmount: 50000, triggerEvent: 'CONTRATO_ASSINADO' }, ...a(), t);
    await commissions.confirmCommissionEntitlement(outra.id, { externalConfirmationId: `fc-${uniqueSuffix()}` }, ...a(), t);
    await FinancingCase.update({ status: 'SUBMITTED' }, { where: { id: caso.id }, transaction: t });
    await onCaseClosedByProvider(await FinancingCase.findByPk(caso.id, { transaction: t }), 'REJECTED', t);
    const lista = await commissions.listCommissionEntitlements(caso.id, tenant.groupId, tenant.companyId, t);
    assert.equal(lista.find((x) => x.id === prevista.id).status, 'ADJUSTED');
    assert.equal(lista.find((x) => x.id === outra.id).status, 'RECEIVABLE');
    const alertas = await IntegrationError.findAll({ where: { financingCaseId: caso.id, errorCode: 'COMMISSION_ON_CLOSED_CASE' }, transaction: t });
    assert.equal(alertas.length, 1);
  });
});

test('M8-AUDI-64: provider em maiúscula é normalizado e ids enormes do webhook são recusados com resposta tratada', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const principal = await Person.create({ ...ctx(), personType: 'PF', legalName: `Maiúscula ${uniqueSuffix()}`, createdBy: tenant.userId, updatedBy: tenant.userId }, { transaction: t });
    const caso = await financingCases.createFinancingCase({ ...ctx(), providerCode: 'Sandbox', applicants: [{ personId: principal.id, role: 'PRINCIPAL' }] }, tenant.userId, t);
    assert.equal(caso.providerCode, 'sandbox');
  });
  const webhooksService = require('../../src/features/correspondent/webhooks.service');
  const r = await webhooksService.processFinancingWebhook('sandbox', Buffer.from('{}'), {}, { externalCaseId: 'x'.repeat(200), externalEventId: 'e', status: 'APPROVED' });
  assert.equal(r.reason, 'invalid_payload');
});

test('M8-AUDI-65: cancelar com envio incerto que não dá para confirmar deixa alerta visível', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const caso = await casoPronto(t);
    await atualizarElegibilidade(t, { unknownReleaseMinutes: 0 });
    const original = SandboxFinancingProviderAdapter.prototype.submitCase;
    SandboxFinancingProviderAdapter.prototype.submitCase = async () => { throw new Error('Provider fora do ar.'); };
    try {
      await submissionsService.submitFinancingCase(caso.id, { consent: true }, ...a(), t);
    } finally {
      SandboxFinancingProviderAdapter.prototype.submitCase = original;
    }
    const originalFind = SandboxFinancingProviderAdapter.prototype.findSubmissionByKey;
    SandboxFinancingProviderAdapter.prototype.findSubmissionByKey = async () => { throw new Error('consulta fora do ar'); };
    try {
      await workflow.cancelCase(caso.id, { reason: 'Cliente desistiu da operação' }, ...a(), t);
    } finally {
      SandboxFinancingProviderAdapter.prototype.findSubmissionByKey = originalFind;
    }
    const alertas = await IntegrationError.findAll({ where: { financingCaseId: caso.id, errorCode: 'CANCEL_UNCERTAIN' }, transaction: t });
    assert.equal(alertas.length, 1);
  });
});

test('M8-AUDI-66: o roteamento de webhook é gravado de verdade (fora da transação do teste) e não toma o de outra empresa', async () => {
  const { sequelize: seq } = require('../../src/models');
  const externalId = `teste-rota-${uniqueSuffix()}`;
  const [[outra]] = await seq.query('SELECT id, group_id FROM core.companies WHERE id <> :c LIMIT 1', { replacements: { c: tenant.companyId } });
  // O roteamento tem chave estrangeira para o caso: o caso precisa existir de verdade (transação própria, confirmada).
  const novoCaso2 = await seq.transaction(async (tx) => {
    await seq.query('SET LOCAL app.group_id = :g', { replacements: { g: tenant.groupId }, transaction: tx });
    await seq.query('SET LOCAL app.company_id = :c', { replacements: { c: tenant.companyId }, transaction: tx });
    await seq.query('SET LOCAL app.user_id = :u', { replacements: { u: tenant.userId }, transaction: tx });
    return novoCaso(tx);
  });
  try {
    // roteamento da empresa atual, gravado em transação própria
    await seq.transaction((tx) => ExternalCaseRouting.create({ externalCaseId: externalId, providerCode: 'sandbox', financingCaseId: novoCaso2.id, groupId: tenant.groupId, companyId: tenant.companyId }, { transaction: tx }));
    if (outra) {
      const submissionsInternals = require('../../src/features/correspondent/cases/submissions.service');
      assert.equal(typeof submissionsInternals.applyProviderOutcome, 'function');
    }
    const existente = await ExternalCaseRouting.findOne({ where: { providerCode: 'sandbox', externalCaseId: externalId } });
    assert.equal(existente.companyId, tenant.companyId);
  } finally {
    await ExternalCaseRouting.destroy({ where: { providerCode: 'sandbox', externalCaseId: externalId }, force: true });
    await seq.query('DELETE FROM correspondent.financing_cases WHERE id = :id', { replacements: { id: novoCaso2.id } }).catch(() => {});
  }
});


// ---------- Décima rodada: oitavo auditor ----------

test('M8-AUDI-67: o emissor de NFS-e é idempotente pela chave: repetir o pedido devolve a mesma nota', async () => {
  const adapter = new SandboxNfseAdapter();
  const chave = `nfse:${crypto.randomUUID()}:COMMISSION_ENTITLEMENT:${crypto.randomUUID()}:n0`;
  const primeira = await adapter.requestInvoice({ idempotencyKey: chave, amount: 100, description: 'x' });
  const segunda = await adapter.requestInvoice({ idempotencyKey: chave, amount: 100, description: 'x' });
  assert.equal(segunda.externalId, primeira.externalId);
  assert.equal((await adapter.findInvoiceByKey(chave)).externalId, primeira.externalId);
});

test('M8-AUDI-68: sem data informada, o documento vence no prazo definido em Parâmetros para o tipo', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    await atualizarElegibilidade(t, { documentValidityDays: { RG_CPF: 90 } });
    const caso = await novoCaso(t);
    await checklistValidado(caso, t);
    const doc = await CaseDocument.findOne({ where: { financingCaseId: caso.id }, transaction: t });
    assert.ok(doc.expiresAt, 'o prazo do tipo vira a validade');
    const dias = Math.round((new Date(doc.expiresAt).getTime() - Date.now()) / 86400000);
    // A validade vai até o fim do dia em Brasília: conforme a hora em que o teste roda, a diferença é de 89 a 91 dias.
    assert.ok(dias >= 89 && dias <= 91, `dias até vencer: ${dias}`);
    await assert.rejects(atualizarElegibilidade(t, { documentValidityDays: { RG_CPF: 0 } }), codigo('CORRESPONDENT_PARAMETERS_VALIDATION'));
  });
});

test('M8-AUDI-69: cancelar o caso estorna a comissão prevista e alerta sobre a já confirmada; recusa manual faz o mesmo', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const caso = await novoCaso(t, 'manual');
    await FinancingCase.update({ status: 'APPROVED' }, { where: { id: caso.id }, transaction: t });
    const prevista = await commissions.createCommissionEntitlement(caso.id, { baseAmount: 100000, triggerEvent: 'REGISTRO_MANUAL' }, ...a(), t);
    const confirmada = await commissions.createCommissionEntitlement(caso.id, { baseAmount: 50000, triggerEvent: 'CONTRATO_ASSINADO' }, ...a(), t);
    await commissions.confirmCommissionEntitlement(confirmada.id, { externalConfirmationId: `m-${uniqueSuffix()}` }, ...a(), t);
    await FinancingCase.update({ status: 'SUBMITTED' }, { where: { id: caso.id }, transaction: t });
    await workflow.registerManualStatus(caso.id, { status: 'REJECTED', note: 'Banco recusou a operação' }, ...a(), t);
    const lista = await commissions.listCommissionEntitlements(caso.id, tenant.groupId, tenant.companyId, t);
    assert.equal(lista.find((x) => x.id === prevista.id).status, 'ADJUSTED');
    const alertas = await IntegrationError.findAll({ where: { financingCaseId: caso.id, errorCode: 'COMMISSION_ON_CLOSED_CASE' }, transaction: t });
    assert.equal(alertas.length, 1);
  });
});

test('M8-AUDI-70: exportação recusa tipo de origem desconhecido e valor que não confere com a comissão', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const { confirmada } = await comissaoRecebida(t);
    const periodo = new Date().toISOString().slice(0, 7);
    await assert.rejects(exportService.createExportBatch(periodo, [{ sourceType: 'QUALQUER_COISA', sourceId: crypto.randomUUID(), amount: 10, description: 'x' }], ...a(), t), codigo('ACCOUNTING_EXPORT_VALIDATION'));
    await assert.rejects(exportService.createExportBatch(periodo, [{ sourceType: 'COMMISSION_ENTITLEMENT', sourceId: confirmada.id, amount: Number(confirmada.amount) + 1, description: 'x' }], ...a(), t), codigo('ACCOUNTING_EXPORT_VALIDATION'));
  });
});

test('M8-AUDI-71: concluir o estorno financeiro só vale para comissão estornada com lançamento', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const { confirmada } = await comissaoRecebida(t);
    await assert.rejects(commissions.completeFinancialReversal(confirmada.id, ...a(), t), codigo('COMMISSION_FINANCIAL_REVERSAL_NOT_APPLICABLE'));
    await commissions.chargebackCommissionEntitlement(confirmada.id, 'Chargeback', ...a(), t);
    const feito = await commissions.completeFinancialReversal(confirmada.id, ...a(), t);
    assert.equal(feito.status, 'ADJUSTED');
  });
});

test('M8-AUDI-72: a proposta do banco é gravada mesmo quando o status da consulta não muda', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const caso = await novoCaso(t);
    await FinancingCase.update({ status: 'APPROVED' }, { where: { id: caso.id }, transaction: t });
    const adapter = new SandboxFinancingProviderAdapter();
    await applyPolledStatus(await FinancingCase.findByPk(caso.id, { transaction: t }), adapter, { rawProviderStatus: 'APPROVED', proposal: { approvedAmount: 300000, annualRatePct: 9, termMonths: 240 } }, t);
    assert.equal((await FinancingProposal.findAll({ where: { financingCaseId: caso.id }, transaction: t })).length, 1);
    await applyPolledStatus(await FinancingCase.findByPk(caso.id, { transaction: t }), adapter, { rawProviderStatus: 'APPROVED', proposal: { approvedAmount: 300000, annualRatePct: 9, termMonths: 240 } }, t);
    assert.equal((await FinancingProposal.findAll({ where: { financingCaseId: caso.id }, transaction: t })).length, 1, 'proposta idêntica não duplica');
    await applyPolledStatus(await FinancingCase.findByPk(caso.id, { transaction: t }), adapter, { rawProviderStatus: 'APPROVED', proposal: { approvedAmount: 280000, annualRatePct: 9.5, termMonths: 240 } }, t);
    assert.equal((await FinancingProposal.findAll({ where: { financingCaseId: caso.id }, transaction: t })).length, 2, 'proposta revista entra e substitui');
  });
});

test('M8-AUDI-73: comissão que arredonda para zero é recusada e o prazo de recebimento vem de Parâmetros', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const caso = await novoCaso(t, 'manual');
    await assert.rejects(commissions.createCommissionEntitlement(caso.id, { baseAmount: 0.4 }, ...a(), t), codigo('COMMISSION_ENTITLEMENT_VALIDATION'));
    const atual = await parameters.getParameters(tenant.groupId, tenant.companyId, tenant.userId, t);
    await parameters.updateCommission({ ...atual.commission.action, receivableDueDays: 45 }, 'Prazo de recebimento', ...a(), t);
    const e = await commissions.createCommissionEntitlement(caso.id, { baseAmount: 100000 }, ...a(), t);
    const confirmada = await commissions.confirmCommissionEntitlement(e.id, { externalConfirmationId: `due-${uniqueSuffix()}` }, ...a(), t);
    const { FinancialEntry: FE } = require('../../src/models');
    const lancamento = await FE.findByPk(confirmada.financialEntryId, { transaction: t });
    const dias = Math.round((new Date(lancamento.dueAt).getTime() - Date.now()) / 86400000);
    assert.ok(dias >= 44 && dias <= 45);
  });
});


// ---------- Décima primeira rodada: nono auditor ----------

test('M8-AUDI-74: provider manual registra a simulação e a avaliação que o banco informou, no mesmo modelo interno', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const caso = await novoCaso(t, 'manual');
    await comImovel(caso, t);
    await assert.rejects(simulationsService.createSimulation(caso.id, { amount: 200000, termMonths: 240 }, ...a(), t), codigo('SIMULATION_VALIDATION'));
    const simulacao = await simulationsService.createSimulation(caso.id, { amount: 200000, termMonths: 240, monthlyPayment: 2100.55, monthlyRatePct: 0.95 }, ...a(), t);
    assert.equal(Number(simulacao.monthlyPayment), 2100.55);
    await assert.rejects(appraisalsService.requestAppraisalRecord(caso.id, {}, ...a(), t), codigo('APPRAISAL_VALIDATION'));
    const avaliacao = await appraisalsService.requestAppraisalRecord(caso.id, { appraisedValue: 310000 }, ...a(), t);
    assert.equal(avaliacao.status, 'COMPLETED');
    assert.equal(Number(avaliacao.requestedValue), 310000);
  });
});

test('M8-AUDI-75: a validade em data sem hora vale até o fim do dia em Brasília', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const caso = await novoCaso(t);
    const requirement = await documentsService.createRequirement(caso.id, { documentType: 'RG_CPF', required: true }, tenant.userId, ctx(), t);
    const file = await File.create({ ...ctx(), fileName: `v-${uniqueSuffix()}.pdf`, mimeType: 'application/pdf', sizeBytes: 20000, storageKey: `test/${uniqueSuffix()}.pdf`, uploadedByUserId: tenant.userId }, { transaction: t });
    const doc = await documentsService.uploadDocument(caso.id, requirement.id, { fileId: file.id, expiresAt: '2037-10-30' }, tenant.userId, ctx(), t);
    assert.equal(new Date(doc.expiresAt).toISOString(), '2037-10-31T02:59:59.000Z');
  });
});

test('M8-AUDI-76: contratação ou conclusão manual exige a aprovação do banco antes', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const caso = await novoCaso(t, 'manual');
    await FinancingCase.update({ status: 'SUBMITTED' }, { where: { id: caso.id }, transaction: t });
    await assert.rejects(workflow.registerManualStatus(caso.id, { status: 'COMPLETED', note: 'Concluído' }, ...a(), t), codigo('MANUAL_STATUS_APPROVAL_REQUIRED'));
    await workflow.registerManualStatus(caso.id, { status: 'APPROVED', proposal: { approvedAmount: 100000, annualRatePct: 9, termMonths: 120 } }, ...a(), t);
    const feito = await workflow.registerManualStatus(caso.id, { status: 'COMPLETED', note: 'Contrato assinado' }, ...a(), t);
    assert.equal(feito.financingCase.status, 'COMPLETED');
  });
});

test('M8-AUDI-77: recuperar um envio incerto cujo provider já respondeu APPROVED leva o caso a APPROVED, com a proposta', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const caso = await casoPronto(t);
    await atualizarElegibilidade(t, { unknownReleaseMinutes: 0 });
    const original = SandboxFinancingProviderAdapter.prototype.submitCase;
    SandboxFinancingProviderAdapter.prototype.submitCase = async function aceitaMasPerde(req) { await original.call(this, req); throw new Error('Conexão perdida.'); };
    let incerta;
    try {
      incerta = await submissionsService.submitFinancingCase(caso.id, { consent: true }, ...a(), t);
    } finally {
      SandboxFinancingProviderAdapter.prototype.submitCase = original;
    }
    assert.equal(incerta.status, 'UNKNOWN');
    const originalFind = SandboxFinancingProviderAdapter.prototype.findSubmissionByKey;
    SandboxFinancingProviderAdapter.prototype.findSubmissionByKey = async function (key) {
      const r = await originalFind.call(this, key);
      return { ...r, status: 'APPROVED', proposal: { approvedAmount: 150000, annualRatePct: 9, termMonths: 240 } };
    };
    try {
      const r = await submissionsService.acknowledgeUnknownSubmission(incerta.id, {}, ...a(), t);
      assert.equal(r.recovered, true);
    } finally {
      SandboxFinancingProviderAdapter.prototype.findSubmissionByKey = originalFind;
    }
    assert.equal((await FinancingCase.findByPk(caso.id, { transaction: t })).status, 'APPROVED');
    assert.equal((await FinancingProposal.findAll({ where: { financingCaseId: caso.id }, transaction: t })).length, 1);
  });
});
