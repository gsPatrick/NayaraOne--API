'use strict';

const catchAsync = require('../../../../utils/catchAsync');
const { success } = require('../../../../utils/httpResponse');
const contractVersionActions = require('./contractVersionActions.service');

/** Rotas literais do Guia §14 (Marco 5) que agem sobre uma versão do contrato. */
const approveContractVersion = catchAsync(async (req, res) => {
  const data = await req.withTenantTransaction((t) => contractVersionActions.approveContractVersion(req.params.id, req.auth.userId, t));
  return success(res, { data });
});

const sendContractVersionForSignature = catchAsync(async (req, res) => {
  const data = await req.withTenantTransaction((t) =>
    contractVersionActions.sendContractVersionForSignature(req.params.id, req.body && req.body.signerPersonIds, req.auth.userId, t)
  );
  return success(res, { statusCode: 201, data });
});

module.exports = { approveContractVersion, sendContractVersionForSignature };
