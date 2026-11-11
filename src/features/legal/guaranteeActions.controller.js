'use strict';

const catchAsync = require('../../utils/catchAsync');
const { success } = require('../../utils/httpResponse');
const guaranteesService = require('./guarantees.service');
const { readOtherFlows } = require('./guaranteeTypeData');

/**
 * Fechamento M5 (Caderno §9 "contrato não perde histórico quando a garantia é substituída"): substituição pela API.
 * A nova garantia é criada no mesmo contrato e a antiga vira RELEASED ligada à nova (replaced_by_guarantee_id),
 * nunca apagada nem editada — mesma função de serviço, auditoria e evento legal.guarantee.replaced.
 */
const replaceGuarantee = catchAsync(async (req, res) => {
  const result = await req.withTenantTransaction((t) => guaranteesService.replaceGuarantee(req.params.id, req.body || {}, req.auth.userId, t));
  return success(res, { statusCode: 201, data: { oldGuarantee: result.oldGuarantee, newGuarantee: result.newGuarantee } });
});

/**
 * 3ª rodada (Caderno §9 OTHER "Fluxo configurado"): quem cadastra garantia (legal:create) lê os fluxos homologados da
 * empresa sem precisar de settings:read — só código, rótulo e campos exigidos.
 */
const listOtherGuaranteeFlows = catchAsync(async (req, res) => {
  const flows = await req.withTenantTransaction((t) => readOtherFlows({ groupId: req.auth.groupId, companyId: req.auth.companyId }, t));
  return success(res, { data: flows.map((f) => ({ code: f.code, label: f.label || f.code, requiredFields: Array.isArray(f.requiredFields) ? f.requiredFields : [] })) });
});

module.exports = { replaceGuarantee, listOtherGuaranteeFlows };
