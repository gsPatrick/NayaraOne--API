'use strict';

const pinoHttp = require('pino-http');
const logger = require('../utils/logger');
const { getCurrentCorrelationId } = require('./correlationId.middleware');
const { httpRequestDuration } = require('../utils/metrics');

/**
 * requestLoggerMiddleware — TEC-13: log estruturado de cada requisição (método, rota, status,
 * duração, correlationId) e alimenta a métrica de latência (ver src/utils/metrics.js). Deve
 * ser montado DEPOIS de correlationIdMiddleware (precisa do correlationId já disponível).
 */
const requestLoggerMiddleware = pinoHttp({
  logger,
  customProps: (req) => ({ correlationId: getCurrentCorrelationId() }),
  autoLogging: {
    ignore: (req) => req.url === '/health' || req.url === '/api/health' || req.url === '/api/metrics',
  },
  customSuccessMessage: (req, res) => `${req.method} ${req.url} ${res.statusCode}`,
  customErrorMessage: (req, res, err) => `${req.method} ${req.url} ${res.statusCode} — ${err.message}`,
});

function metricsRecorderMiddleware(req, res, next) {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const durationSeconds = Number(process.hrtime.bigint() - start) / 1e9;
    const route = req.route?.path || req.baseUrl || req.path || 'unknown';
    httpRequestDuration.observe({ method: req.method, route, status_code: res.statusCode }, durationSeconds);
  });
  next();
}

module.exports = { requestLoggerMiddleware, metricsRecorderMiddleware };
