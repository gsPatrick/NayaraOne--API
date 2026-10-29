'use strict';

const catchAsync = require('../../../utils/catchAsync');
const { success } = require('../../../utils/httpResponse');
const service = require('./ingestion.service');
const { classifyFile } = require('./fileClassification.service');
const E = require('./retrieval.errors');

const ctxDe = (req) => ({ groupId: req.auth.groupId, companyId: req.auth.companyId, userId: req.auth.userId, permissions: req.auth.permissions });
const tx = (req, fn) => req.withTenantTransaction(fn);

/**
 * POST /ai/ingestions. A linha REJECTED/FAILED é gravada e a transação confirmada ANTES de a resposta de erro sair (o erro é lançado aqui,
 * depois do commit), então o registro de por que o documento foi recusado sobrevive à resposta 422.
 */
const create = catchAsync(async (req, res) => {
  const out = await tx(req, (t) => service.ingest(ctxDe(req), req.body, t));
  if (['REJECTED', 'FAILED'].includes(out.ingestion.status)) throw E.rejectionError(out.ingestion.errorCode, out.ingestion.id);
  return success(res, { statusCode: out.replayed ? 200 : 201, data: out.ingestion, meta: { replayed: out.replayed } });
});

const getOne = catchAsync(async (req, res) => success(res, { data: await tx(req, (t) => service.get(ctxDe(req), req.params.id, t)) }));

const classify = catchAsync(async (req, res) => success(res, { data: await tx(req, (t) => classifyFile(ctxDe(req), req.params.fileId, req.body, t)) }));

module.exports = { create, getOne, classify };
