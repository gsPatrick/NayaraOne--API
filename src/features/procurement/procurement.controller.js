'use strict';

const catchAsync = require('../../utils/catchAsync');
const { success } = require('../../utils/httpResponse');
const service = require('./procurement.service');
const approvalThresholdRulesService = require('./approvalThresholdRules.service');

function withTenant(req) {
  return { ...req.body, groupId: req.auth.groupId, companyId: req.auth.companyId };
}

const createPurchaseRequest = catchAsync(async (req, res) => {
  const request = await req.withTenantTransaction((t) => service.createPurchaseRequest(withTenant(req), req.auth.userId, t));
  return success(res, { statusCode: 201, data: request });
});
const listPurchaseRequests = catchAsync(async (req, res) => {
  const requests = await req.withTenantTransaction((t) => service.listPurchaseRequests(req.auth.groupId, req.auth.companyId, t, { status: req.query.status }));
  return success(res, { data: requests });
});
const getPurchaseRequest = catchAsync(async (req, res) => {
  const request = await req.withTenantTransaction((t) => service.getPurchaseRequest(req.params.id, req.auth.groupId, req.auth.companyId, t));
  return success(res, { data: request });
});
const decidePurchaseRequest = catchAsync(async (req, res) => {
  const request = await req.withTenantTransaction((t) => service.decidePurchaseRequest(req.params.id, req.auth.groupId, req.auth.companyId, req.body.decision, req.auth.userId, t));
  return success(res, { data: request });
});

const createQuotation = catchAsync(async (req, res) => {
  const quotation = await req.withTenantTransaction((t) => service.createQuotation(req.params.id, req.auth.groupId, req.auth.companyId, req.auth.userId, t));
  return success(res, { statusCode: 201, data: quotation });
});
const submitSupplierOffer = catchAsync(async (req, res) => {
  const offer = await req.withTenantTransaction((t) => service.submitSupplierOffer(req.params.id, req.auth.groupId, req.auth.companyId, req.body, t));
  return success(res, { statusCode: 201, data: offer });
});
const compareOffers = catchAsync(async (req, res) => {
  const offers = await req.withTenantTransaction((t) => service.compareOffers(req.params.id, req.auth.groupId, req.auth.companyId, t));
  return success(res, { data: offers });
});
const awardSupplierOffer = catchAsync(async (req, res) => {
  const order = await req.withTenantTransaction((t) => service.awardSupplierOffer(req.params.id, req.auth.groupId, req.auth.companyId, req.auth.userId, t));
  return success(res, { statusCode: 201, data: order });
});

const listPurchaseOrders = catchAsync(async (req, res) => {
  const orders = await req.withTenantTransaction((t) => service.listPurchaseOrders(req.auth.groupId, req.auth.companyId, t, { status: req.query.status }));
  return success(res, { data: orders });
});
const getPurchaseOrder = catchAsync(async (req, res) => {
  const order = await req.withTenantTransaction((t) => service.getPurchaseOrder(req.params.id, req.auth.groupId, req.auth.companyId, t));
  return success(res, { data: order });
});
const confirmGoodsReceipt = catchAsync(async (req, res) => {
  const actor = { userId: req.auth.userId, canApprove: req.auth.permissions?.includes('inventory:approve') };
  const result = await req.withTenantTransaction((t) => service.confirmGoodsReceipt(req.params.id, req.auth.groupId, req.auth.companyId, req.body, actor, t));
  return success(res, { statusCode: 201, data: result });
});
const listGoodsReceipts = catchAsync(async (req, res) => {
  const receipts = await req.withTenantTransaction((t) => service.listGoodsReceipts(req.auth.groupId, req.auth.companyId, t, { purchaseOrderId: req.params.id }));
  return success(res, { data: receipts });
});

const listDiscrepancies = catchAsync(async (req, res) => {
  const discrepancies = await req.withTenantTransaction((t) => service.listDiscrepancies(req.auth.groupId, req.auth.companyId, t, { status: req.query.status }));
  return success(res, { data: discrepancies });
});

const resolveDiscrepancy = catchAsync(async (req, res) => {
  const discrepancy = await req.withTenantTransaction((t) =>
    service.resolveDiscrepancy(req.params.id, req.auth.groupId, req.auth.companyId, req.body, { userId: req.auth.userId }, t)
  );
  return success(res, { data: discrepancy });
});

const evaluateSupplier = catchAsync(async (req, res) => {
  const evaluation = await req.withTenantTransaction((t) => service.evaluateSupplier(withTenant(req), req.auth.userId, t));
  return success(res, { statusCode: 201, data: evaluation });
});

const listSupplierEvaluations = catchAsync(async (req, res) => {
  const result = await req.withTenantTransaction((t) => service.listSupplierEvaluations(t, { supplierPersonId: req.query.supplierPersonId }));
  return success(res, { data: result });
});

const cancelPurchaseOrder = catchAsync(async (req, res) => {
  const result = await req.withTenantTransaction((t) => service.cancelPurchaseOrder(req.params.id, req.auth.groupId, req.auth.companyId, req.body, { userId: req.auth.userId }, t));
  return success(res, { data: result });
});

const upsertSupplierQualification = catchAsync(async (req, res) => {
  const actor = { canApprove: req.auth.permissions?.includes('procurement:approve') };
  const qualification = await req.withTenantTransaction((t) => service.upsertSupplierQualification(withTenant(req), req.auth.userId, actor, t));
  return success(res, { statusCode: 201, data: qualification });
});

const decideSupplierDueDiligence = catchAsync(async (req, res) => {
  const qualification = await req.withTenantTransaction((t) =>
    service.decideSupplierDueDiligence(req.params.id, req.auth.groupId, req.auth.companyId, req.body, { userId: req.auth.userId }, t)
  );
  return success(res, { data: qualification });
});

const listSupplierQualifications = catchAsync(async (req, res) => {
  const qualifications = await req.withTenantTransaction((t) => service.listSupplierQualifications(req.auth.groupId, req.auth.companyId, t, { supplierPersonId: req.query.supplierPersonId }));
  // SEC — dueDiligenceNotes guarda achados sigilosos da investigação (processos judiciais,
  // restrições financeiras, dados bancários indiretos do fornecedor); quem só tem
  // procurement:read não deve ver o conteúdo, só o status, senão qualquer leitor básico acessa
  // informação que deveria ficar restrita a quem aprova due diligence (procurement:approve).
  const canSeeDueDiligenceNotes = req.auth.permissions?.includes('procurement:approve');
  const sanitized = canSeeDueDiligenceNotes
    ? qualifications
    : qualifications.map((q) => {
        const plain = typeof q.toJSON === 'function' ? q.toJSON() : q;
        return { ...plain, dueDiligenceNotes: null };
      });
  return success(res, { data: sanitized });
});

// REG-COM-001 — limite de valor para segunda aprovação de pedido de compra (mesmo padrão de
// rota de inventory/adjustment-risk-rule).
const getApprovalThresholdRule = catchAsync(async (req, res) => {
  const rule = await req.withTenantTransaction((t) =>
    approvalThresholdRulesService.getActiveSecondApprovalThreshold(req.auth.groupId, req.auth.companyId, t, req.auth.userId)
  );
  return success(res, { data: rule });
});
const createApprovalThresholdRule = catchAsync(async (req, res) => {
  const rule = await req.withTenantTransaction((t) => approvalThresholdRulesService.createApprovalThresholdRule(withTenant(req), req.auth.userId, t));
  return success(res, { statusCode: 201, data: rule });
});

module.exports = {
  createPurchaseRequest,
  listPurchaseRequests,
  getPurchaseRequest,
  decidePurchaseRequest,
  createQuotation,
  submitSupplierOffer,
  compareOffers,
  awardSupplierOffer,
  listPurchaseOrders,
  getPurchaseOrder,
  confirmGoodsReceipt,
  listGoodsReceipts,
  listDiscrepancies,
  resolveDiscrepancy,
  evaluateSupplier,
  listSupplierEvaluations,
  cancelPurchaseOrder,
  upsertSupplierQualification,
  decideSupplierDueDiligence,
  listSupplierQualifications,
  getApprovalThresholdRule,
  createApprovalThresholdRule,
};
