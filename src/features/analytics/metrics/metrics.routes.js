'use strict';

const { Router } = require('express');
const AppError = require('../../../utils/AppError');
const { readMetricAsOf } = require('./registry.asOf');
const { resolveAsOf } = require('./period');
const { consolidateMetric } = require('./consolidation.service');

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
    const asOfDate = resolveAsOf(req.query.asOf); // M9-D606: data de calendário de SP; futuro é 400 ANALYTICS_AS_OF_FUTURE
    if (req.query.groupId !== undefined) { // M9-D625: consolidado do grupo, calculado só na leitura (grupo alheio 404, sem analytics:read:group 403)
      const data = await req.withTenantTransaction((transaction) => consolidateMetric(
        { companyId, groupId, actorUserId: req.auth.userId, permissions }, { metricCode: req.params.code, groupId: req.query.groupId, asOfDate }, transaction
      ));
      return res.json({ data });
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
