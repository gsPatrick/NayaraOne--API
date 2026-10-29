'use strict';

// M9-D698 (3.4) — o refresh protege o OLTP: statement_timeout (analytics.refresh.timeout_ms), lock_timeout (analytics.refresh.lock_timeout_ms,
// padrão 2 s) e lote limitado, tanto no evento quanto na agenda; e o GET de BI tem o próprio tempo máximo (504 ANALYTICS_QUERY_TIMEOUT).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env607 = require('../_helpers/m9d607Env');
const readModels = require('../../../src/features/analytics/read-models');
const { lockAggregate } = require('../../../src/features/analytics/read-models/readModel.upsert');
const { analyticsReadOnlyTransaction } = require('../../../src/features/analytics/readOnly');
const { upsertSetting } = require('../../../src/features/settings/settings.service');

const { inTx, addSource, makeEvent, sequelize } = env607;
let env;
let sleepSeconds = 0;

before(async () => {
  env = await env607.setup();
  const original = env.def.recompute;
  env.def.recompute = async (args) => {
    if (sleepSeconds) await sequelize.query('SELECT pg_sleep(:s)', { replacements: { s: sleepSeconds }, transaction: args.transaction });
    return original(args);
  };
});
after(async () => {
  await env.admin.query("DELETE FROM core.tenant_settings WHERE key LIKE 'analytics.refresh.%' OR key = 'analytics.consulta.timeout_ms'");
  await env607.teardown(env);
});

const setParam = (key, value) => inTx(env.tenantA, { commit: true }, (tx) => upsertSetting(key, value, env.tenantA, env.tenantA.userId, tx));
const clearParams = () => env.admin.query("DELETE FROM core.tenant_settings WHERE key LIKE 'analytics.refresh.%' OR key = 'analytics.consulta.timeout_ms'");
const pgCode = (err) => err?.parent?.code || err?.original?.code || err?.cause?.parent?.code || err?.code;
const account = () => `conta-${env607.sfx()}`;

test('m9d698 refresh respeita lock_timeout e statement_timeout', async () => {
  await clearParams();
  const params = await inTx(env.tenantA, {}, (tx) => readModels.readRefreshParams(env.tenantA, tx));
  assert.equal(params.timeoutMs, 30000, 'statement_timeout padrão do livro: 30.000 ms');
  assert.equal(params.lockTimeoutMs, 2000, "lock_timeout padrão do livro: '2s'");
  assert.equal(params.batchRows, 5000, 'lote padrão do livro: 5.000 linhas');

  // statement_timeout: a leitura da fonte demora 2 s e o limite é 300 ms.
  await setParam('analytics.refresh.timeout_ms', 300);
  const acc = account();
  await addSource(env, env.tenantA, acc, '10.00');
  sleepSeconds = 2;
  const t0 = Date.now();
  try {
    await assert.rejects(inTx(env.tenantA, {}, (tx) => readModels.applyEvent(makeEvent(env, env.tenantA, acc), tx)), (err) => pgCode(err) === '57014');
  } finally {
    sleepSeconds = 0;
  }
  assert.ok(Date.now() - t0 < 1900, 'cancelado pelo limite, não esperou os 2 s');

  // O limite vale só durante o refresh: depois ele volta ao que a sessão tinha.
  await clearParams();
  await inTx(env.tenantA, {}, async (tx) => {
    const [[before1]] = await sequelize.query("SELECT current_setting('lock_timeout') AS v", { transaction: tx });
    await readModels.applyEvent(makeEvent(env, env.tenantA, acc), tx);
    const [[after1]] = await sequelize.query("SELECT current_setting('lock_timeout') AS v", { transaction: tx });
    assert.equal(after1.v, before1.v, 'lock_timeout e statement_timeout restaurados');
  });

  // lock_timeout: outro processo segura a trava do agregado.
  await setParam('analytics.refresh.lock_timeout_ms', 300);
  const hot = account();
  await addSource(env, env.tenantA, hot, '5.00');
  const holder = await sequelize.transaction();
  try {
    await sequelize.query("SELECT set_config('app.company_id', :c, true), set_config('app.group_id', :g, true)", { replacements: { c: env.tenantA.companyId, g: env.tenantA.groupId }, transaction: holder });
    await lockAggregate(env.def, env.tenantA.companyId, { account_id: hot }, holder);
    const started = Date.now();
    await assert.rejects(inTx(env.tenantA, {}, (tx) => readModels.applyEvent(makeEvent(env, env.tenantA, hot), tx)), (err) => pgCode(err) === '55P03');
    const waited = Date.now() - started;
    assert.ok(waited >= 250 && waited < 2000, `esperou ${waited} ms: nem imediato, nem os 2 s padrão`);
  } finally {
    await holder.rollback();
  }
  await clearParams();
});

test('m9d698 a agenda também protege o OLTP: leitura lenta vira refresh FAILED e não segura o lote', async () => {
  await clearParams();
  await setParam('analytics.refresh.timeout_ms', 300);
  const acc = account();
  await addSource(env, env.tenantA, acc, '10.00', { settled: false });
  sleepSeconds = 2;
  const started = Date.now();
  try {
    const out = await inTx(env.tenantA, { commit: true }, async (tx) => readModels.refreshCompanyScheduled(
      env.tenantA, await readModels.readRefreshParams(env.tenantA, tx), tx, { now: new Date('2026-10-28T15:00:00Z') }
    ));
    assert.ok(out.some((r) => r.readModel === env.model && r.failed), JSON.stringify(out));
  } finally {
    sleepSeconds = 0;
  }
  assert.ok(Date.now() - started < 1900);
  const [[row]] = await env.admin.query("SELECT status, error_code FROM analytics.read_model_refreshes WHERE read_model = :m AND \"trigger\" = 'SCHEDULE' ORDER BY started_at DESC LIMIT 1", { replacements: { m: env.model } });
  assert.equal(row.status, 'FAILED');
  await clearParams();
});

test('m9d698 GET de BI tem tempo máximo próprio e estouro vira 504 ANALYTICS_QUERY_TIMEOUT', async () => {
  await clearParams();
  const run = async (failWith) => {
    const req = {
      method: 'GET', auth: { groupId: env.tenantA.groupId, companyId: env.tenantA.companyId, userId: env.tenantA.userId }, originalUrl: '/v1/analytics/x', correlationId: 'c',
      withTenantTransaction: (fn) => inTx(env.tenantA, {}, async (tx) => (failWith ? failWith(tx) : fn(tx))),
    };
    await new Promise((resolve, reject) => analyticsReadOnlyTransaction(req, {}, (err) => (err ? reject(err) : resolve())));
    return req;
  };
  let seen;
  await (await run()).withTenantTransaction(async (tx) => { [[seen]] = await sequelize.query("SELECT current_setting('statement_timeout') AS v", { transaction: tx }); });
  assert.equal(seen.v, '10s', 'padrão: 10.000 ms');
  await setParam('analytics.consulta.timeout_ms', 150);
  await (await run()).withTenantTransaction(async (tx) => { [[seen]] = await sequelize.query("SELECT current_setting('statement_timeout') AS v", { transaction: tx }); });
  assert.equal(seen.v, '150ms', 'o tempo máximo é parâmetro');
  const req = await run();
  await assert.rejects(req.withTenantTransaction((tx) => sequelize.query('SELECT pg_sleep(1)', { transaction: tx })), (err) => {
    assert.equal(err.statusCode, 504);
    assert.equal(err.code, 'ANALYTICS_QUERY_TIMEOUT');
    assert.equal(err.message, 'A consulta demorou mais que o permitido. Tente novamente.');
    return true;
  });
  await clearParams();
});
