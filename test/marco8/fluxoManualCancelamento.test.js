'use strict';

// Marco 8 — workflow manual assistido, cancelamento e proposta do banco.
// Caderno: "Provider sem API usa workflow manual assistido mantendo o mesmo modelo interno" e a máquina
// de estados DRAFT → … → APPROVED/REJECTED → CONTRACTING → COMPLETED ou CANCELED.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('../testHelpers');
const financingCasesService = require('../../src/features/correspondent/cases/financingCases.service');
const workflow = require('../../src/features/correspondent/cases/caseWorkflow.service');
const documentsService = require('../../src/features/correspondent/cases/caseDocuments.service');
const simulationsService = require('../../src/features/correspondent/cases/simulations.service');
const webhooksService = require('../../src/features/correspondent/webhooks.service');
const { Person, ProviderSubmission, OutboxEvent, FinancingProposal } = require('../../src/models');

let tenant;
before(async () => { tenant = await getSeedTenant(); });
after(async () => { await sequelize.close(); });

const ctx = () => ({ groupId: tenant.groupId, companyId: tenant.companyId });

async function novoCaso(transaction, providerCode, status) {
  const principal = await Person.create(
    { ...ctx(), personType: 'PF', legalName: `Proponente fluxo ${uniqueSuffix()}`, createdBy: tenant.userId, updatedBy: tenant.userId },
    { transaction }
  );
  const caso = await financingCasesService.createFinancingCase(
    { ...ctx(), providerCode, applicants: [{ personId: principal.id, role: 'PRINCIPAL' }] },
    tenant.userId,
    transaction
  );
  if (status) {
    caso.status = status;
    await caso.save({ transaction });
  }
  return caso;
}

const registrar = (transaction, casoId, payload) => workflow.registerManualStatus(casoId, payload, tenant.userId, tenant.groupId, tenant.companyId, transaction);
const cancelar = (transaction, casoId, payload) => workflow.cancelCase(casoId, payload, tenant.userId, tenant.groupId, tenant.companyId, transaction);
const codigo = (c) => (err) => { assert.equal(err.code, c, `esperava ${c}, veio ${err.code}: ${err.message}`); return true; };

test('M8-MAN-01: caso manual percorre análise, pendências, aprovação com proposta, contratação e conclusão', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const caso = await novoCaso(t, 'manual', 'SUBMITTED');
    for (const status of ['UNDER_ANALYSIS', 'PENDING_CUSTOMER', 'PENDING_PROPERTY']) {
      const r = await registrar(t, caso.id, { status, note: 'Conversa com o gerente do banco' });
      assert.equal(r.financingCase.status, status);
    }
    const aprovado = await registrar(t, caso.id, { status: 'APPROVED', proposal: { approvedAmount: 250000, annualRatePct: 10.5, termMonths: 360, monthlyPayment: 2300.55, validUntil: '2026-12-31' } });
    assert.equal(aprovado.financingCase.status, 'APPROVED');
    assert.equal(aprovado.proposal.status, 'ACTIVE');
    assert.equal(Number(aprovado.proposal.approvedAmount), 250000);

    const contratando = await registrar(t, caso.id, { status: 'CONTRACTING', proposal: { approvedAmount: 240000, annualRatePct: 10, termMonths: 300 } });
    assert.equal(contratando.financingCase.status, 'CONTRACTING');
    const propostas = await workflow.listProposals(caso.id, tenant.groupId, tenant.companyId, t);
    assert.equal(propostas.length, 2);
    assert.equal(propostas.filter((p) => p.status === 'ACTIVE').length, 1, 'só uma proposta vigente');
    assert.equal(Number(propostas.find((p) => p.status === 'ACTIVE').approvedAmount), 240000);
    assert.ok(propostas.every((p) => p.source === 'MANUAL'));

    const fim = await registrar(t, caso.id, { status: 'COMPLETED' });
    assert.equal(fim.financingCase.status, 'COMPLETED');

    const { rows: historico } = await sequelize.query(
      'SELECT raw_provider_status, normalized_status, source, applied FROM correspondent.provider_status_history WHERE financing_case_id = :id ORDER BY occurred_at',
      { replacements: { id: caso.id }, transaction: t, type: sequelize.QueryTypes.SELECT, plain: false, raw: true }
    ).then((rows) => ({ rows }));
    assert.equal(historico.length, 6);
    assert.ok(historico.every((h) => h.source === 'manual' && h.applied === true));

    const eventos = await OutboxEvent.findAll({ where: { aggregateId: caso.id }, transaction: t });
    const tipos = eventos.map((e) => e.eventType);
    assert.ok(tipos.includes('financing.approved'));
    assert.ok(tipos.includes('financing.completed'));
    assert.equal(tipos.filter((x) => x === 'financing.status.changed').length, 6);
  });
});

test('M8-MAN-02: recusas do fluxo manual (provider com API, ainda não enviado, repetido, voltando, sem motivo, proposta inválida)', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const comApi = await novoCaso(t, 'sandbox', 'SUBMITTED');
    await assert.rejects(() => registrar(t, comApi.id, { status: 'APPROVED' }), codigo('FINANCING_CASE_NOT_MANUAL'));

    const rascunho = await novoCaso(t, 'manual');
    await assert.rejects(() => registrar(t, rascunho.id, { status: 'APPROVED' }), codigo('FINANCING_CASE_NOT_SUBMITTED'));

    const caso = await novoCaso(t, 'manual', 'SUBMITTED');
    await assert.rejects(() => registrar(t, caso.id, { status: 'SUBMITTED' }), codigo('MANUAL_STATUS_VALIDATION'));
    await assert.rejects(() => registrar(t, caso.id, { status: 'BANANA' }), codigo('MANUAL_STATUS_VALIDATION'));
    await assert.rejects(() => registrar(t, caso.id, { status: 'REJECTED' }), codigo('MANUAL_STATUS_REASON_REQUIRED'));
    await assert.rejects(() => registrar(t, caso.id, { status: 'UNDER_ANALYSIS', proposal: { approvedAmount: 1, termMonths: 1 } }), codigo('MANUAL_STATUS_VALIDATION'));
    for (const proposal of [{ approvedAmount: -5, termMonths: 12 }, { approvedAmount: 1000, termMonths: 0 }, { approvedAmount: 1000, termMonths: 481 }, { approvedAmount: 1000, termMonths: 12, annualRatePct: 101 }, { approvedAmount: 1000, termMonths: 12, monthlyPayment: 0 }, { approvedAmount: 1000, termMonths: 12, validUntil: '31/12/2026' }]) {
      await assert.rejects(() => registrar(t, caso.id, { status: 'APPROVED', proposal }), codigo('PROPOSAL_VALIDATION'));
    }
    assert.equal((await workflow.listProposals(caso.id, tenant.groupId, tenant.companyId, t)).length, 0, 'proposta inválida não grava nada');

    await registrar(t, caso.id, { status: 'APPROVED' });
    await assert.rejects(() => registrar(t, caso.id, { status: 'APPROVED' }), codigo('MANUAL_STATUS_ALREADY_APPLIED'));
    await assert.rejects(() => registrar(t, caso.id, { status: 'UNDER_ANALYSIS' }), codigo('MANUAL_STATUS_OUT_OF_ORDER'));
    await assert.rejects(() => registrar(t, caso.id, { status: 'REJECTED', note: 'Banco mudou de ideia' }), codigo('MANUAL_STATUS_OUT_OF_ORDER'));
  });
});

test('M8-CAN-01: cancelar exige motivo, cancela submissão pendente, bloqueia novas ações e não cancela caso concluído', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const caso = await novoCaso(t, 'sandbox', 'READY_TO_SUBMIT');
    const pendente = await ProviderSubmission.create(
      { ...ctx(), financingCaseId: caso.id, providerCode: 'sandbox', idempotencyKey: `cancel-${uniqueSuffix()}`, snapshotHash: 'a'.repeat(64), requestSnapshot: {}, status: 'PENDING', createdBy: tenant.userId },
      { transaction: t }
    );
    await assert.rejects(() => cancelar(t, caso.id, {}), codigo('CASE_CANCEL_REASON_REQUIRED'));
    await assert.rejects(() => cancelar(t, caso.id, { reason: 'ab' }), codigo('CASE_CANCEL_REASON_REQUIRED'));

    const cancelado = await cancelar(t, caso.id, { reason: 'Cliente desistiu da compra' });
    assert.equal(cancelado.status, 'CANCELED');
    assert.equal(cancelado.canceledReason, 'Cliente desistiu da compra');
    assert.ok(cancelado.canceledAt);
    await pendente.reload({ transaction: t });
    assert.equal(pendente.status, 'CANCELED');
    assert.equal(pendente.failureReason, 'CASO_CANCELADO');

    await assert.rejects(() => cancelar(t, caso.id, { reason: 'de novo' }), codigo('CASE_ALREADY_CANCELED'));
    await assert.rejects(() => documentsService.createRequirement(caso.id, { documentType: 'RG_CPF' }, tenant.userId, ctx(), t), codigo('FINANCING_CASE_CANCELED'));
    await assert.rejects(() => simulationsService.createSimulation(caso.id, { amount: 1000, termMonths: 12 }, tenant.userId, tenant.groupId, tenant.companyId, t), codigo('FINANCING_CASE_CANCELED'));

    const { rows: hist } = await sequelize.query(
      "SELECT normalized_status, source FROM correspondent.provider_status_history WHERE financing_case_id = :id",
      { replacements: { id: caso.id }, transaction: t, type: sequelize.QueryTypes.SELECT, raw: true }
    ).then((rows) => ({ rows }));
    assert.deepEqual(hist.map((h) => `${h.normalized_status}:${h.source}`), ['CANCELED:manual']);

    const concluido = await novoCaso(t, 'manual', 'COMPLETED');
    await assert.rejects(() => cancelar(t, concluido.id, { reason: 'Quero cancelar mesmo assim' }), codigo('CASE_CANCEL_NOT_ALLOWED'));
  });
});

test('M8-MAP-01: o provider alcança todos os estados internos (pendência do imóvel, contratação e cancelamento)', async () => {
  const { resolveFinancingProviderAdapterByCode } = require('../../src/features/correspondent/adapters/resolveFinancingProviderAdapter');
  const adapter = resolveFinancingProviderAdapterByCode('sandbox');
  assert.equal(adapter.normalizeProviderStatus('PROPERTY_PENDING'), 'PENDING_PROPERTY');
  assert.equal(adapter.normalizeProviderStatus('CONTRACTING'), 'CONTRACTING');
  assert.equal(adapter.normalizeProviderStatus('CANCELED'), 'CANCELED');
  assert.equal(adapter.normalizeProviderStatus('CANCELLED'), 'CANCELED');
  assert.equal(adapter.normalizeProviderStatus('RECEIVED'), 'SUBMITTED');
  assert.equal(adapter.normalizeProviderStatus('STATUS_QUE_NAO_EXISTE'), null);
  assert.ok(typeof webhooksService.processFinancingWebhook === 'function');
  assert.equal(FinancingProposal.tableName, 'proposals');
});
