'use strict';

const { Router } = require('express');
const AppError = require('../../../utils/AppError');
const { businessDateKey } = require('../../../utils/businessDate');
const { readMetricAsOf } = require('./registry.asOf');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * GET /analytics/metrics/:code?asOf=AAAA-MM-DD (M9-D604, 3.4). Resolve a versão vigente na data e devolve o snapshot gravado dela,
 * lendo só metric_snapshots (sem cálculo). Escopo desta rota: a empresa do usuário (`companyId` informado de outra empresa é 404, nunca
 * 403). Os demais parâmetros (período, grupo, dimensão, comparação) e o contrato completo são da M9-D702, que estende este handler.
 */
async function getMetric(req, res, next) {
  try {
    const { companyId, groupId, permissions } = req.auth;
    if (req.query.companyId && req.query.companyId !== companyId) {
      throw AppError.notFound('Empresa não encontrada ou sem acesso.', 'ANALYTICS_SCOPE_NOT_FOUND');
    }
    const asOfDate = req.query.asOf === undefined ? businessDateKey(new Date()) : String(req.query.asOf);
    if (!DATE_RE.test(asOfDate) || Number.isNaN(Date.parse(`${asOfDate}T00:00:00Z`))) {
      throw AppError.badRequest('A data (asOf) deve estar no formato AAAA-MM-DD.', 'ANALYTICS_PERIOD_INVALID');
    }
    const data = await req.withTenantTransaction((transaction) => readMetricAsOf(
      { companyId, groupId, permissions }, { metricCode: req.params.code, scopeType: 'COMPANY', scopeId: companyId, asOfDate }, transaction
    ));
    res.json({ data });
  } catch (err) {
    next(err);
  }
}

function createMetricsRouter() {
  const router = Router();
  router.get('/:code', getMetric);
  return router;
}

module.exports = { createMetricsRouter };
