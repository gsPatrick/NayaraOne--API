'use strict';

// Auditoria contratual Marco 7 (2026-10-07): "Cancelar pedido" e "due diligence de fornecedor"
// existiam só como service + rota, sem nenhuma tela no front. As telas novas
// (NayaraOne--FRONT app/painel/compras/pedidos e app/painel/compras/fornecedores) chamam
// EXATAMENTE os paths abaixo via lib/api/procurement.js (cancelPurchaseOrder,
// upsertSupplierQualification, listSupplierQualifications, decideSupplierDueDiligence).
// Este arquivo sobe o app real (`app.listen` numa porta alternativa, mesmo padrão de
// construction.httpRoutes.test.js) e bate HTTP de verdade nesses paths — JWT real, middleware
// de tenant real, RLS real, envelope {success,data}/{success:false,error} real — e confirma
// também o gate de permissão (procurement:approve) que a UI espelha ao esconder os botões.
//
// Requisição HTTP real comita a própria transação (tenant.middleware) — por isso o `after()`
// limpa explicitamente (hard delete, ordem inversa de FK) tudo que foi criado aqui.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.PORT = process.env.PROCUREMENT_HTTP_TEST_PORT || '34593';

const app = require('../app'); // eslint-disable-line no-unused-vars
const { sequelize, getSeedTenant, withTenantTransaction, uniqueSuffix } = require('./testHelpers');
const { signAccessToken } = require('../src/utils/jwt');
const procurementService = require('../src/features/procurement/procurement.service');
const {
  Person,
  PurchaseRequest,
  PurchaseRequestItem,
  Quotation,
  SupplierOffer,
  SupplierOfferItem,
  PurchaseOrder,
  PurchaseOrderItem,
  SupplierQualification,
  User,
} = require('../src/models');

let tenant;
let baseUrl;
let approverToken;
let buyerToken;
// GAP REAL CORRIGIDO (segregação "quem cria não aprova", 2026-10-08): decidePurchaseRequest
// agora rejeita quando o ator é o mesmo que criou a requisição — createOpenOrder usava
// tenant.userId para criar E decidir. Segundo usuário, persistido de verdade (requisição HTTP
// comita a própria transação) e limpo no after(), mesmo padrão de personIds/requestIds abaixo.
let secondApprover;

const created = { personIds: [], requestIds: [], orderIds: [], qualificationIds: [], userIds: [] };

before(async () => {
  tenant = await getSeedTenant();
  const base = { sub: tenant.userId, group_id: tenant.groupId, company_id: tenant.companyId, roles: ['admin'] };
  approverToken = signAccessToken({ ...base, permissions: ['procurement:read', 'procurement:create', 'procurement:approve'] });
  // Comprador sem poder de aprovação — o mesmo perfil para o qual a UI esconde Cancelar/Aprovar/Reprovar.
  buyerToken = signAccessToken({ ...base, roles: ['buyer'], permissions: ['procurement:read', 'procurement:create'] });
  baseUrl = `http://127.0.0.1:${process.env.PORT}/api/v1`;
  secondApprover = await User.create({
    name: `QA HTTP segundo aprovador ${uniqueSuffix()}`,
    email: `qa-http-approver-${uniqueSuffix()}@nayaraone.dev`,
    passwordHash: 'x',
    status: 'ACTIVE',
  });
  created.userIds.push(secondApprover.id);
  await new Promise((resolve) => setTimeout(resolve, 300));
});

after(async () => {
  await withTenantTransaction(tenant, async (transaction) => {
    if (created.qualificationIds.length) await SupplierQualification.destroy({ where: { id: created.qualificationIds }, force: true, transaction });
    if (created.orderIds.length) {
      await PurchaseOrderItem.destroy({ where: { purchaseOrderId: created.orderIds }, force: true, transaction });
      await PurchaseOrder.destroy({ where: { id: created.orderIds }, force: true, transaction });
    }
    if (created.requestIds.length) {
      const quotations = await Quotation.findAll({ where: { purchaseRequestId: created.requestIds }, transaction });
      const quotationIds = quotations.map((q) => q.id);
      if (quotationIds.length) {
        const offers = await SupplierOffer.findAll({ where: { quotationId: quotationIds }, transaction });
        const offerIds = offers.map((o) => o.id);
        if (offerIds.length) {
          await SupplierOfferItem.destroy({ where: { supplierOfferId: offerIds }, force: true, transaction });
          await SupplierOffer.destroy({ where: { id: offerIds }, force: true, transaction });
        }
        await Quotation.destroy({ where: { id: quotationIds }, force: true, transaction });
      }
      await PurchaseRequestItem.destroy({ where: { purchaseRequestId: created.requestIds }, force: true, transaction });
      await PurchaseRequest.destroy({ where: { id: created.requestIds }, force: true, transaction });
    }
    if (created.personIds.length) await Person.destroy({ where: { id: created.personIds }, force: true, transaction });
  }).catch((err) => {
    // Limpeza best-effort: não mascarar o resultado dos testes por causa dela.
    console.error('[procurement.httpRoutes] limpeza falhou:', err.message);
  });
  if (created.userIds.length) await User.destroy({ where: { id: created.userIds }, force: true }).catch(() => {});
  await sequelize.close();
  process.exit(0);
});

function call(method, path, token, body) {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function createSupplier() {
  const person = await withTenantTransaction(tenant, (transaction) =>
    Person.create(
      { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PJ', legalName: `QA HTTP Fornecedor ${uniqueSuffix()}`, createdBy: tenant.userId, updatedBy: tenant.userId },
      { transaction }
    )
  );
  created.personIds.push(person.id);
  return person;
}

async function createOpenOrder(supplierPersonId) {
  const order = await withTenantTransaction(tenant, async (transaction) => {
    const request = await procurementService.createPurchaseRequest(
      { groupId: tenant.groupId, companyId: tenant.companyId, items: [{ description: `QA HTTP item ${uniqueSuffix()}`, quantity: 5 }] },
      tenant.userId,
      transaction
    );
    created.requestIds.push(request.id);
    await procurementService.decidePurchaseRequest(request.id, tenant.groupId, tenant.companyId, 'APPROVED', secondApprover.id, transaction);
    const quotation = await procurementService.createQuotation(request.id, tenant.groupId, tenant.companyId, tenant.userId, transaction);
    const offer = await procurementService.submitSupplierOffer(
      quotation.id, tenant.groupId, tenant.companyId,
      { supplierPersonId, items: [{ purchaseRequestItemId: request.items[0].id, unitPrice: 12 }] },
      transaction
    );
    return procurementService.awardSupplierOffer(offer.id, tenant.groupId, tenant.companyId, tenant.userId, transaction);
  });
  created.orderIds.push(order.id);
  return order;
}

test('HTTP POST /procurement/purchase-orders/:id/cancel — cancela, devolve {order, discrepancies}, recusa recancelar e exige procurement:approve', async () => {
  const supplier = await createSupplier();
  const order = await createOpenOrder(supplier.id);

  const forbidden = await call('POST', `/procurement/purchase-orders/${order.id}/cancel`, buyerToken, { reason: 'sem permissão' });
  assert.equal(forbidden.status, 403);
  assert.equal((await forbidden.json()).error.code, 'PERMISSION_DENIED');

  const res = await call('POST', `/procurement/purchase-orders/${order.id}/cancel`, approverToken, { reason: 'Fornecedor não vai entregar' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true);
  assert.equal(body.data.order.id, order.id);
  assert.equal(body.data.order.status, 'CANCELED');
  assert.ok(Array.isArray(body.data.discrepancies), 'a UI lê data.discrepancies para mostrar a compensação registrada');
  assert.equal(body.data.discrepancies.length, 0, 'PO sem nenhum recebimento não gera UNDER_RECEIPT (não há recebimento onde pendurar)');

  const detail = await call('GET', `/procurement/purchase-orders/${order.id}`, approverToken);
  assert.equal((await detail.json()).data.status, 'CANCELED');

  const again = await call('POST', `/procurement/purchase-orders/${order.id}/cancel`, approverToken, {});
  assert.equal(again.status, 409);
  assert.equal((await again.json()).error.code, 'PURCHASE_ORDER_INVALID_TRANSITION');
});

test('HTTP supplier-qualifications — registrar risco/documentos, listar por fornecedor, aprovar/reprovar due diligence (só procurement:approve)', async () => {
  const supplier = await createSupplier();

  const upsert = await call('POST', '/procurement/supplier-qualifications', buyerToken, {
    supplierPersonId: supplier.id,
    highRisk: true,
    validUntil: '2099-12-31',
    documentFileIds: [],
  });
  assert.equal(upsert.status, 201);
  const qualification = (await upsert.json()).data;
  created.qualificationIds.push(qualification.id);
  assert.equal(qualification.supplierPersonId, supplier.id);
  assert.equal(qualification.highRisk, true);
  assert.equal(qualification.dueDiligenceStatus, 'PENDING', 'alto risco abre due diligence pendente');
  assert.equal(qualification.companyId, tenant.companyId, 'tenant vem do token, nunca do body');

  const list = await call('GET', `/procurement/supplier-qualifications?supplierPersonId=${supplier.id}`, buyerToken);
  assert.equal(list.status, 200);
  const listed = (await list.json()).data;
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, qualification.id);

  const buyerDecides = await call('POST', `/procurement/supplier-qualifications/${qualification.id}/decide`, buyerToken, { decision: 'APPROVED' });
  assert.equal(buyerDecides.status, 403);
  assert.equal((await buyerDecides.json()).error.code, 'PERMISSION_DENIED');

  const invalid = await call('POST', `/procurement/supplier-qualifications/${qualification.id}/decide`, approverToken, { decision: 'MAYBE' });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error.code, 'SUPPLIER_QUALIFICATION_VALIDATION');

  const rejected = await call('POST', `/procurement/supplier-qualifications/${qualification.id}/decide`, approverToken, { decision: 'REJECTED', notes: 'CND vencida' });
  assert.equal(rejected.status, 200);
  const rejectedBody = (await rejected.json()).data;
  assert.equal(rejectedBody.dueDiligenceStatus, 'REJECTED');
  assert.equal(rejectedBody.dueDiligenceNotes, 'CND vencida');

  // Reenviar o cadastro (novos documentos) com o fornecedor ainda alto risco reabre a análise.
  const resubmitted = await call('POST', '/procurement/supplier-qualifications', buyerToken, { supplierPersonId: supplier.id, highRisk: true, documentFileIds: [] });
  assert.equal(resubmitted.status, 201);
  assert.equal((await resubmitted.json()).data.dueDiligenceStatus, 'PENDING');

  const approved = await call('POST', `/procurement/supplier-qualifications/${qualification.id}/decide`, approverToken, { decision: 'APPROVED', notes: 'Documentação conferida' });
  assert.equal(approved.status, 200);
  const approvedBody = (await approved.json()).data;
  assert.equal(approvedBody.dueDiligenceStatus, 'APPROVED');
  assert.equal(approvedBody.approvedByUserId, tenant.userId);
  assert.ok(approvedBody.approvedAt);

  // Deixar de ser alto risco zera a exigência — e decidir due diligence passa a ser recusado.
  // `validUntil` ausente mantém a vigência já cadastrada.
  const lowered = await call('POST', '/procurement/supplier-qualifications', buyerToken, { supplierPersonId: supplier.id, highRisk: false });
  const loweredBody = (await lowered.json()).data;
  assert.equal(loweredBody.dueDiligenceStatus, 'NOT_REQUIRED');
  assert.equal(loweredBody.validUntil, '2099-12-31');

  // `validUntil: null` explícito (campo de vigência apagado na tela) LIMPA a vigência — antes o
  // `validUntil || atual` do service devolvia sempre o valor antigo.
  const cleared = await call('POST', '/procurement/supplier-qualifications', buyerToken, { supplierPersonId: supplier.id, highRisk: false, validUntil: null });
  assert.equal((await cleared.json()).data.validUntil, null);

  const notRequired = await call('POST', `/procurement/supplier-qualifications/${qualification.id}/decide`, approverToken, { decision: 'APPROVED' });
  assert.equal(notRequired.status, 400);
  assert.equal((await notRequired.json()).error.code, 'SUPPLIER_QUALIFICATION_NOT_HIGH_RISK');
});
