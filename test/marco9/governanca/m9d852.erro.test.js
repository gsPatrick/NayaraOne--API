'use strict';

// M9-D852 §3.2 — erro 500 sem stack em produção, com o traceId na frase; campo `debug` só fora de produção e com o parâmetro ligado.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { randomUUID } = require('node:crypto');
const { correlationIdMiddleware } = require('../../../src/middlewares/correlationId.middleware');
const errorHandler = require('../../../src/middlewares/errorHandler');
const { assertDebugAllowed, debugBody } = require('../../../src/shared/destructive-actions/debug.policy');
const { DISPOSABLE, SKIP_DISPOSABLE } = require('../../m9d801.helpers');

const skipDb = DISPOSABLE ? false : SKIP_DISPOSABLE;

function appWith(extra) {
  const app = express();
  app.use(correlationIdMiddleware);
  if (extra) app.use(extra);
  app.get('/boom', () => { throw new Error('SELECT * FROM tabela_secreta falhou em /srv/app/src/x.js'); });
  app.use(errorHandler);
  return app;
}

async function hit(app, headers = {}) {
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/boom`, { headers });
    return { status: res.status, headers: res.headers, body: await res.json(), text: JSON.stringify(await Promise.resolve({})) };
  } finally {
    server.close();
  }
}

const withEnv = async (value, fn) => {
  const before = process.env.NODE_ENV;
  process.env.NODE_ENV = value;
  try { return await fn(); } finally { process.env.NODE_ENV = before; }
};

after(() => { setTimeout(() => process.exit(0), 200); });

test('m9d852 erro 500 em produção não contém stack, SQL nem caminho e traz o traceId de 36 caracteres na frase', async () => {
  await withEnv('production', async () => {
    const correlationId = randomUUID();
    const res = await hit(appWith(), { 'X-Correlation-Id': correlationId });
    assert.equal(res.status, 500);
    const raw = JSON.stringify(res.body);
    assert.equal(res.body.error.traceId.length, 36);
    assert.equal(res.body.error.traceId, correlationId);
    assert.equal(res.headers.get('x-correlation-id'), correlationId);
    assert.equal(res.body.error.code, 'INTERNAL_ERROR');
    assert.equal(res.body.error.message, `Algo deu errado. Informe o código ${correlationId} ao suporte.`);
    for (const leak of ['stack', 'debug', 'SELECT', 'tabela_secreta', '/srv/app', '.js', ' at ']) assert.ok(!raw.includes(leak), `vazou "${leak}"`);
  });
});

test('m9d852 fora de produção, sem o parâmetro ligado, o corpo do 500 também não traz stack', async () => {
  await withEnv('test', async () => {
    const res = await hit(appWith());
    assert.equal(res.status, 500);
    assert.equal(res.body.error.debug, undefined);
    assert.ok(!JSON.stringify(res.body).includes('tabela_secreta'));
  });
});

test('m9d852 governanca.ui.exibir_debug é proibido em produção: gravar true é recusado e a leitura é ignorada', () => {
  assert.doesNotThrow(() => withEnvSync('test', () => assertDebugAllowed('governanca.ui.exibir_debug', true)));
  assert.doesNotThrow(() => withEnvSync('production', () => assertDebugAllowed('governanca.ui.exibir_debug', false)));
  assert.throws(() => withEnvSync('production', () => assertDebugAllowed('governanca.ui.exibir_debug', true)), (e) => e.statusCode === 400 && e.code === 'SETTING_INVALID_VALUE');
  const err = new Error('x');
  assert.equal(withEnvSync('production', () => debugBody(err, true)), undefined);
  assert.equal(withEnvSync('test', () => debugBody(err, false)), undefined);
  assert.deepEqual(Object.keys(withEnvSync('test', () => debugBody(err, true))), ['message', 'stack']);
});

function withEnvSync(value, fn) {
  const before = process.env.NODE_ENV;
  process.env.NODE_ENV = value;
  try { return fn(); } finally { process.env.NODE_ENV = before; }
}

test('m9d852 com o parâmetro ligado, fora de produção, o campo separado debug traz a mensagem e a stack; em produção nunca', { skip: skipDb }, async () => {
  const { loadTenants } = require('../../m9d801.helpers');
  const { withTenantTransaction } = require('../../testHelpers');
  const env = require('../_helpers/m9d852Env');
  const tenants = await loadTenants();
  const tenant = tenants.A;
  const asTenant = (req, res, next) => { req.auth = { ...tenant }; req.withTenantTransaction = (fn) => withTenantTransaction(tenant, fn); next(); };
  await env.setSetting(tenant, 'governanca.ui.exibir_debug', true);
  try {
    await withEnv('test', async () => {
      const res = await hit(appWith(asTenant));
      assert.equal(res.status, 500);
      assert.match(res.body.error.debug.message, /tabela_secreta/);
      assert.match(res.body.error.debug.stack, /Error: SELECT/);
      assert.equal(res.body.error.message, `Algo deu errado. Informe o código ${res.body.error.traceId} ao suporte.`);
    });
    await withEnv('production', async () => {
      const res = await hit(appWith(asTenant));
      assert.equal(res.body.error.debug, undefined);
      assert.ok(!JSON.stringify(res.body).includes('tabela_secreta'));
    });
  } finally {
    await env.setSetting(tenant, 'governanca.ui.exibir_debug', undefined);
    await require('../../../src/models').sequelize.close().catch(() => {});
  }
});
