'use strict';

// M9-D608 — rebuild reproduz o resultado do incremental, é determinístico, reaplica eventos que chegam durante a reconstrução e
// não deixa a tabela atual pela metade em caso de falha. Banco descartável (ver analytics.m9d603.test.js).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env608 = require('../_helpers/m9d608Env');
const readModels = require('../../../src/features/analytics/read-models');

const { addSource, applyCommitted, tableRows, ctxFor, lastRefresh, shadowExists } = env608;
let env;

before(async () => { env = await env608.setup(); });
after(() => env608.teardown(env));

const rebuild = (tenant, extra = {}, reason = null) => readModels.rebuildReadModel(ctxFor(tenant, { reason }), { model: env.model, companyId: tenant.companyId, ...extra });
const total = (rows) => rows.reduce((acc, r) => acc + Number(r.balance), 0).toFixed(2);

async function seedIncremental(tenant) {
  await addSource(env, tenant, 'caixa', '119000.00');
  await addSource(env, tenant, 'caixa', '1000.00');
  await addSource(env, tenant, 'reserva', '5000.50');
  await addSource(env, tenant, 'reserva', '200.00', false);
  await applyCommitted(env, tenant, 'caixa');
  await applyCommitted(env, tenant, 'reserva');
}

test('m9d608 rebuild read model reproduz resultado do incremental', async () => {
  await seedIncremental(env.tenantA);
  await seedIncremental(env.tenantB);
  const incremental = await tableRows(env, env.tenantA);
  const incrementalB = await tableRows(env, env.tenantB);
  assert.equal(total(incremental), '125000.50');
  assert.equal(incremental.find((r) => r.account_id === 'caixa').balance, '120000.00');

  const result = await rebuild(env.tenantA);
  assert.equal(result.status, 'SUCCEEDED');
  assert.deepEqual(await tableRows(env, env.tenantA), incremental, 'linha a linha, campo a campo: idêntico ao incremental');
  assert.equal(total(await tableRows(env, env.tenantA)), '125000.50', 'KPI derivado (caixa livre) igual');
  assert.equal(result.before.hash, result.after.hash, 'mesmo hash por empresa antes e depois');
  assert.deepEqual([result.added, result.removed, result.changed], [0, 0, 0], 'nada difere, então nem o motivo é exigido');
  assert.deepEqual(await tableRows(env, env.tenantB), incrementalB, 'a outra empresa não foi tocada');
  assert.equal(await shadowExists(env), false, 'a tabela sombra é descartada ao fim');

  const refresh = await lastRefresh(env, env.tenantA);
  assert.equal(refresh.status, 'SUCCEEDED');
  assert.equal(refresh.rows_upserted, 2);
  assert.ok(refresh.source_snapshot_at, 'source_snapshot_at = instante da fotografia');
  assert.equal(refresh.rebuild_diff.before.hash, result.before.hash);
  const [[version]] = await env.admin.query(`SELECT version, source_snapshot_at FROM analytics.${env.model} WHERE company_id = :c AND account_id = 'caixa'`, { replacements: { c: env.tenantA.companyId } });
  assert.equal(version.version, 2, 'a versão do read model vem da definição registrada');
  assert.ok(version.source_snapshot_at);
});

test('m9d608 dois rebuilds seguidos têm o mesmo hash', async () => {
  const first = await rebuild(env.tenantA);
  const second = await rebuild(env.tenantA);
  assert.equal(first.after.hash, second.after.hash);
  assert.equal(second.before.hash, second.after.hash);
  assert.equal(first.after.rows, second.after.rows);
});

test('m9d608 evento durante o rebuild é reaplicado', async () => {
  let event;
  const result = await rebuild(env.tenantA, {
    hooks: {
      // a sombra já foi lida na fotografia; aqui o worker aplica um evento de conta existente e outro de conta nova
      afterShadow: async () => {
        await addSource(env, env.tenantA, 'caixa', '500.00');
        event = await applyCommitted(env, env.tenantA, 'caixa');
        await addSource(env, env.tenantA, 'nova', '77.70');
        await applyCommitted(env, env.tenantA, 'nova');
      },
    },
  }, 'Reconstrução com eventos em andamento');
  assert.equal(result.reapplied, 2, 'as duas contas tocadas durante a reconstrução foram recalculadas');
  const rows = await tableRows(env, env.tenantA);
  assert.equal(rows.find((r) => r.account_id === 'caixa').balance, '120500.00', 'o valor do evento durante o rebuild não se perdeu');
  assert.equal(rows.find((r) => r.account_id === 'nova').balance, '77.70', 'conta nova criada durante o rebuild existe');
  const [[applied]] = await env.admin.query('SELECT count(*)::int AS n FROM analytics.rm_applied_events WHERE read_model = :m AND source_event_id = :e', { replacements: { m: env.model, e: event.id } });
  assert.equal(applied.n, 1, 'rm_applied_events é preservado');
  const replay = await env608.inTx(env.tenantA, {}, (tx) => readModels.applyEvent(event, tx));
  assert.equal(replay.replayIgnored, 1, 'o replay do evento continua ignorado depois do rebuild');
  const again = await rebuild(env.tenantA);
  assert.equal(again.before.hash, again.after.hash, 'o resultado do rebuild já continha o estado do evento');
});

test('m9d608 falha no meio mantém tabela atual', async () => {
  const before1 = await tableRows(env, env.tenantA);
  const hash = (await rebuild(env.tenantA)).before.hash;
  await addSource(env, env.tenantA, 'reserva', '999.00');
  await addSource(env, env.tenantA, 'zzz', '1.00');
  env.failAccounts.add('zzz'); // a última conta lida da fonte falha: a sombra está pela metade
  await assert.rejects(rebuild(env.tenantA, {}, 'tentativa'), (e) => e.code === 'M9D608_FONTE');
  env.failAccounts.clear();
  assert.deepEqual(await tableRows(env, env.tenantA), before1, 'a tabela atual ficou intacta');
  assert.equal(await shadowExists(env), false, 'a sombra foi descartada');
  const failed = await lastRefresh(env, env.tenantA);
  assert.equal(failed.status, 'FAILED');
  assert.equal(failed.error_code, 'M9D608_FONTE');

  // falha na troca (depois de a sombra estar pronta): a transação da troca desfaz tudo
  env.def.rebuild.corrections = async () => { throw Object.assign(new Error('falha na correção de snapshots'), { code: 'M9D608_CORRECAO' }); };
  await assert.rejects(rebuild(env.tenantA, {}, 'tentativa 2'), (e) => e.code === 'M9D608_CORRECAO');
  assert.deepEqual(await tableRows(env, env.tenantA), before1, 'troca desfeita por inteiro');
  assert.equal(await shadowExists(env), false);
  env.def.rebuild.corrections = async () => env.corrections.splice(0);

  const ok = await rebuild(env.tenantA, {}, 'agora com a fonte corrigida');
  assert.equal(ok.status, 'SUCCEEDED', 'o lock foi liberado e a reconstrução seguinte funciona');
  assert.equal(ok.before.hash, hash, 'o hash antes é o do estado que sobrou intacto');
  assert.notEqual(ok.after.hash, hash);
  assert.deepEqual([ok.added, ok.removed, ok.changed], [1, 0, 1], 'a conta zzz entrou e a reserva mudou');
});
