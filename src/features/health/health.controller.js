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

// FIX TEC-19 (homologação 10/09/2026, drill real): sem timeout próprio, `sequelize.authenticate()`
// pode ficar pendurado por dezenas de segundos quando o host do banco está inacessível (o
// timeout de "acquire" do pool do Sequelize não limita o tempo do connect() TCP de verdade em
// todo cenário — confirmado num teste real apontando pra um IP inalcançável: /health não
// respondia em 20+ segundos). Um healthcheck que trava é pior que um que falha rápido — o
// orquestrador (Easypanel) não sabe se o processo travou ou só está devagar. Timeout próprio
// garante resposta em no máximo HEALTH_CHECK_TIMEOUT_MS, sempre.
const HEALTH_CHECK_TIMEOUT_MS = 4000;

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout após ${ms}ms`)), ms)),
  ]);
}

/**
 * GET /health
 * Verifica a saúde do processo e, quando possível, a conectividade com o banco. Também informa
 * o commit publicado (campo `commit`) e o instante em que este processo subiu (`deployedAt`) —
 * usado para confirmar, sem ambiguidade, qual versão está de fato no ar num ambiente.
 * Não depende de contexto de tenant — usado por load balancers/orquestradores. SEMPRE responde
 * em até HEALTH_CHECK_TIMEOUT_MS, mesmo se o banco estiver completamente inacessível.
 */
const getHealth = catchAsync(async (req, res) => {
  let database = 'unknown';
  try {
    await withTimeout(sequelize.authenticate(), HEALTH_CHECK_TIMEOUT_MS);
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
    await withTimeout(sequelize.query('SELECT 1'), HEALTH_CHECK_TIMEOUT_MS);
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

module.exports = { getHealth, getPing, getDbReadiness, withTimeout, HEALTH_CHECK_TIMEOUT_MS };
