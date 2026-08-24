'use strict';

const catchAsync = require('../../utils/catchAsync');
const { success } = require('../../utils/httpResponse');
const { sequelize } = require('../../config/database');

/**
 * GET /health
 * Verifica a saúde do processo e, quando possível, a conectividade com o banco.
 * Não depende de contexto de tenant — usado por load balancers/orquestradores.
 */
const getHealth = catchAsync(async (req, res) => {
  let database = 'unknown';
  try {
    await sequelize.authenticate();
    database = 'up';
  } catch (err) {
    database = 'down';
  }

  return success(res, {
    data: {
      status: 'ok',
      database,
      uptimeSeconds: process.uptime(),
      timestamp: new Date().toISOString(),
    },
  });
});

/**
 * GET /v1/ping
 * Sanity check simples da camada de API versionada.
 */
const getPing = catchAsync(async (req, res) => {
  return success(res, { data: { pong: true, timestamp: new Date().toISOString() } });
});

/**
 * GET /v1/health/db
 * Readiness real de banco — falha (503) se o Postgres não responder a uma query simples.
 * Diferente de /health (liveness), que nunca deve depender de dependências externas.
 */
const getDbReadiness = catchAsync(async (req, res) => {
  const startedAt = Date.now();
  try {
    await sequelize.query('SELECT 1');
  } catch (err) {
    return success(res, {
      statusCode: 503,
      data: { status: 'not_ready', database: 'down', error: err.message },
    });
  }
  return success(res, {
    data: { status: 'ready', database: 'up', latencyMs: Date.now() - startedAt, timestamp: new Date().toISOString() },
  });
});

module.exports = { getHealth, getPing, getDbReadiness };
