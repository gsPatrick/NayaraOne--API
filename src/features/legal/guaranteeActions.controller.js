'use strict';

const catchAsync = require('../../utils/catchAsync');
const { success } = require('../../utils/httpResponse');
const guaranteesService = require('./guarantees.service');

/**
 * Fechamento M5 (Caderno §9 "contrato não perde histórico quando a garantia é substituída"): substituição pela API.
 * A nova garantia é criada no mesmo contrato e a antiga vira RELEASED ligada à nova (replaced_by_guarantee_id),
 * nunca apagada nem editada — mesma função de serviço, auditoria e evento legal.guarantee.replaced.
 */
const replaceGuarantee = catchAsync(async (req, res) => {
  const result = await req.withTenantTransaction((t) => guaranteesService.replaceGuarantee(req.params.id, req.body || {}, req.auth.userId, t));
  return success(res, { statusCode: 201, data: { oldGuarantee: result.oldGuarantee, newGuarantee: result.newGuarantee } });
});

module.exports = { replaceGuarantee };
