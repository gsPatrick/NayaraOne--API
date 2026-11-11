'use strict';

const catchAsync = require('../../utils/catchAsync');
const { success } = require('../../utils/httpResponse');
const keyDeliveriesService = require('./keyDeliveries.service');

/**
 * Fechamento M5 (Guia §14 "POST /contracts/:id/key-delivery — Entregar chaves"; Guia §11 deliverKeys):
 * entrega de chaves do contrato numa chamada só — abre a entrega e libera na MESMA transação, com os
 * mesmos gates de `releaseKeyDelivery` (contrato SIGNED/ACTIVE, vistoria de entrada assinada, garantia
 * vigente, quantidade, fotos pela política do servidor, termo assinado). Se qualquer gate falhar, nada
 * fica gravado (nem a entrega PENDING) e a resposta é o mesmo erro da liberação.
 */
const deliverKeysForContract = catchAsync(async (req, res) => {
  const body = req.body || {};
  const item = await req.withTenantTransaction(async (t) => {
    const created = await keyDeliveriesService.createKeyDelivery(
      {
        groupId: req.auth.groupId,
        companyId: req.auth.companyId,
        contractId: req.params.id,
        inspectionId: body.inspectionId,
        deliveredToPersonId: body.deliveredToPersonId,
        notes: body.notes,
        termType: body.termType,
      },
      req.auth.userId,
      t
    );
    return keyDeliveriesService.releaseKeyDelivery(created.id, body, req.auth.userId, t);
  });
  return success(res, { statusCode: 201, data: item });
});

module.exports = { deliverKeysForContract };
