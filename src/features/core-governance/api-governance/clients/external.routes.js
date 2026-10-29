'use strict';

const { Router } = require('express');
const catchAsync = require('../../../../utils/catchAsync');
const { errorEnvelope } = require('../../governance.errors');
const { paginationGuard } = require('../standards/pagination.helper');
const { clientAuth, requireScope } = require('./clientAuth.middleware');
const { issueToken } = require('./token.service');
const { listProperties } = require('./external.properties');
const { listContracts } = require('./external.contracts');
const { createLead } = require('./external.leads');
const { assertAllRoutesDeclareScope } = require('./external.sweep');

/**
 * Rotas da API externa (M9-D844), sob /api-external. O envelope de erro com `error.traceId` vale aqui como nos módulos de governança. Toda rota fora a emissão do token declara um scope
 * do catálogo (`requireScope`) e passa por `clientAuth`; a varredura ao montar o router derruba a API se alguma rota ficar sem scope.
 */
const router = Router();
router.use('/api-external', errorEnvelope);

router.post('/api-external/oauth/token', catchAsync(async (req, res) => {
  const token = await issueToken(req.body || {});
  res.set({ 'Cache-Control': 'no-store', Pragma: 'no-cache' });
  return res.status(200).json(token);
}));

router.use('/api-external', clientAuth);

const ok = (res, result, statusCode = 200) => res.status(statusCode).json({ success: true, data: result.items || result, ...(result.pagination ? { pagination: result.pagination } : {}) });

router.get('/api-external/properties', requireScope('properties:read'), paginationGuard, catchAsync(async (req, res) => ok(res, await listProperties(req.apiClient, req.query))));
router.get('/api-external/contracts', requireScope('contracts:read'), paginationGuard, catchAsync(async (req, res) => ok(res, await listContracts(req.apiClient, req.query))));
router.post('/api-external/leads', requireScope('leads:write'), catchAsync(async (req, res) => ok(res, await createLead(req.apiClient, req.body || {}), 201)));

assertAllRoutesDeclareScope(router);

module.exports = router;
