'use strict';

const catchAsync = require('../../../utils/catchAsync');
const { success } = require('../../../utils/httpResponse');
const service = require('./commissionEntitlements.service');
const AppError = require('../../../utils/AppError');
const { CommissionEntitlement } = require('../../../models');
const { getConfirmRequiresFinancePermission } = require('../commissionSplit.service');

// O direito de comissão precisa pertencer ao caso da URL (não vale confirmar/estornar um direito de outro caso por engano).
async function assertEntitlementBelongsToCase(req, transaction) {
  const entitlementId = service.normalizeUuid(req.params.entitlementId, 'O direito a comissão');
  const caseId = service.normalizeUuid(req.params.id, 'O caso');
  const entitlement = await CommissionEntitlement.findOne({
    where: { id: entitlementId, groupId: req.auth.groupId, companyId: req.auth.companyId },
    attributes: ['id', 'financingCaseId'],
    transaction,
  });
  if (!entitlement || entitlement.financingCaseId !== caseId) {
    throw AppError.notFound('Direito a comissão não encontrado neste caso.', 'COMMISSION_ENTITLEMENT_NOT_FOUND');
  }
}

const createCommissionEntitlement = catchAsync(async (req, res) => {
  const entitlement = await req.withTenantTransaction((t) =>
    service.createCommissionEntitlement(req.params.id, req.body, req.auth.userId, req.auth.groupId, req.auth.companyId, t)
  );
  return success(res, { statusCode: 201, data: entitlement });
});

const confirmCommissionEntitlement = catchAsync(async (req, res) => {
  const entitlement = await req.withTenantTransaction(async (t) => {
    await assertEntitlementBelongsToCase(req, t);
    // Segregação: confirmar gera recebível real no Financeiro; por padrão exige também a permissão
    // financeira (a empresa pode desligar em Parâmetros).
    if (await getConfirmRequiresFinancePermission(req.auth.groupId, req.auth.companyId, req.auth.userId, t)) {
      if (!req.auth.permissions.includes('finance:settle')) {
        throw AppError.forbidden('Confirmar uma comissão gera um recebível no Financeiro e exige a permissão financeira (finance:settle).', 'PERMISSION_DENIED', { required: 'finance:settle' });
      }
    }
    return service.confirmCommissionEntitlement(req.params.entitlementId, req.body, req.auth.userId, req.auth.groupId, req.auth.companyId, t);
  });
  return success(res, { data: entitlement });
});

const chargebackCommissionEntitlement = catchAsync(async (req, res) => {
  const result = await req.withTenantTransaction(async (t) => {
    await assertEntitlementBelongsToCase(req, t);
    return service.chargebackCommissionEntitlement(req.params.entitlementId, req.body?.reason, req.auth.userId, req.auth.groupId, req.auth.companyId, t, { amount: req.body?.amount });
  });
  return success(res, { data: result });
});

const receiveCommissionEntitlement = catchAsync(async (req, res) => {
  const entitlement = await req.withTenantTransaction(async (t) => {
    await assertEntitlementBelongsToCase(req, t);
    return service.receiveCommissionEntitlement(req.params.entitlementId, req.auth.userId, req.auth.groupId, req.auth.companyId, t, {
      receivedAt: req.body?.receivedAt,
      receivedAmount: req.body?.receivedAmount,
      bankAccountId: req.body?.bankAccountId,
      differenceReason: req.body?.differenceReason,
    });
  });
  return success(res, { data: entitlement });
});

const completeFinancialReversal = catchAsync(async (req, res) => {
  const entitlement = await req.withTenantTransaction(async (t) => {
    await assertEntitlementBelongsToCase(req, t);
    return service.completeFinancialReversal(req.params.entitlementId, req.auth.userId, req.auth.groupId, req.auth.companyId, t);
  });
  return success(res, { data: entitlement });
});

const listCommissionEntitlements = catchAsync(async (req, res) => {
  const entitlements = await req.withTenantTransaction((t) =>
    service.listCommissionEntitlements(req.params.id, req.auth.groupId, req.auth.companyId, t, { limit: req.query?.limit, offset: req.query?.offset })
  );
  return success(res, { data: entitlements });
});

const listCommissionAdjustments = catchAsync(async (req, res) => {
  const adjustments = await req.withTenantTransaction((t) =>
    service.listCommissionAdjustmentsForCase(req.params.id, req.params.entitlementId, req.auth.groupId, req.auth.companyId, t)
  );
  return success(res, { data: adjustments });
});

module.exports = {
  completeFinancialReversal,
  createCommissionEntitlement,
  confirmCommissionEntitlement,
  receiveCommissionEntitlement,
  chargebackCommissionEntitlement,
  listCommissionEntitlements,
  listCommissionAdjustments,
};
