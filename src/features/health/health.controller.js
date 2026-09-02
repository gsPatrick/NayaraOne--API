'use strict';

const fs = require('fs');
const path = require('path');
const catchAsync = require('../../utils/catchAsync');
const { success } = require('../../utils/httpResponse');
const { sequelize } = require('../../config/database');

// VERSION é gerado no build da imagem Docker (ver Dockerfile, estágio "version") a partir do
// commit real que o build usou — não depende de nenhum passo manual no deploy. Lido uma vez no
// boot do processo: cada deploy sobe um processo novo, então isso já reflete o commit certo.
const VERSION_FILE = path.join(__dirname, '../../../VERSION');
let commit = 'unknown';
try {
  commit = fs.readFileSync(VERSION_FILE, 'utf8').trim();
} catch (err) {
  // Ambiente local sem o arquivo (fora do build Docker) — não é erro, só não tem commit pra
  // informar. `npm run dev` local não gera VERSION.
}
const deployedAt = new Date().toISOString();

/**
 * GET /health
 * Verifica a saúde do processo e, quando possível, a conectividade com o banco. Também informa
 * o commit publicado (campo `commit`) e o instante em que este processo subiu (`deployedAt`) —
 * usado para confirmar, sem ambiguidade, qual versão está de fato no ar num ambiente.
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
      commit,
      deployedAt,
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
