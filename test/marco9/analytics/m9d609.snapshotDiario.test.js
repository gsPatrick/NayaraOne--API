'use strict';

// M9-D609 (BI-007, 3.3 e 3.4) — snapshot diário às 00:30 de São Paulo para D-1 com a versão vigente, catch-up com captured_late, idempotência,
// concorrência, imutabilidade e consulta "como estava naquele dia". Usa um provedor de snapshot de teste (o dos KPIs financeiros é provado em
// m9d609.snapshotFinanceiro.test.js). Banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const e = require('../_helpers/m9d609Env');
const providers = require('../../../src/features/analytics/metrics/snapshots.providers');
const { runDailySnapshots } = require('../../../src/features/analytics/metrics/snapshots.service');
const { onSnapshotFailed } = require('../../../src/features/analytics/metrics/snapshots.events');

let env;
let tenant;
let metric;
let off;
const calls = [];
const scope = () => ({ companyId: tenant.companyId, groupId: tenant.groupId });
const run = (iso, options = {}) => runDailySnapshots(scope(), { now: new Date(iso), ...options });
const rowsOf = async (code) => (await env.admin.query(
  `SELECT s.as_of_date::text AS d, s.captured_late, s.revision_no, s.metric_version_id, s.calc_hash, s.source_refs, s.value_numeric
     FROM analytics.metric_snapshots s JOIN analytics.metric_definitions d ON d.id = s.metric_id WHERE d.metric_code = :code AND s.company_id = :c ORDER BY s.as_of_date`,
  { replacements: { code, c: tenant.companyId } }))[0];
const clearDays = () => env.admin.query('DELETE FROM analytics.snapshot_job_runs WHERE company_id = :c', { replacements: { c: tenant.companyId } });
const clearSnaps = (id) => env.admin.query('DELETE FROM analytics.metric_snapshots WHERE metric_id = :id', { replacements: { id } });

before(async () => {
  env = await e.setup();
  tenant = env.tenantA;
  metric = await e.publish(env, tenant, { criticality: 'CRITICAL' });
  off = providers.registerSnapshotProvider({
    name: 'm9d609-teste',
    metricCodes: [metric.code],
    async build(sc, asOfDate) {
      calls.push(asOfDate);
      if (asOfDate === '2026-10-26') return []; // dia sem linha no read model
      return [{ code: metric.code, inputs: [{
        metricId: metric.definition.id, metricVersionId: metric.version.id, companyId: sc.companyId, groupId: sc.groupId, scopeType: 'COMPANY', scopeId: sc.companyId,
        periodStart: asOfDate, periodEnd: asOfDate, asOfDate, valueNumeric: '7.0000', status: 'OK', sourceSnapshotAt: `${asOfDate}T23:50:00Z`,
        sourceRefs: [{ type: 'TABLE', table: 'x', filterHash: e.sha(asOfDate), filterSignature: 'assinatura', count: 2 }], calcHash: e.sha(`calc${asOfDate}`),
      }] }];
    },
  });
});
after(async () => { off(); await e.teardown(env); });

test('m9d609 snapshot diário às 00:30 SP grava D-1 com a versão vigente', async () => {
  const before0030 = await run('2026-10-30T03:29:00Z'); // 00:29 em São Paulo
  assert.equal(before0030.ran, false);
  assert.deepEqual(await rowsOf(metric.code), [], 'antes das 00:30 nada é gravado');
  const result = await run('2026-10-30T03:30:00Z'); // 00:30 em São Paulo
  assert.equal(result.ran, true);
  const rows = await rowsOf(metric.code);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].d, '2026-10-29', 'a data-base é D-1');
  assert.equal(rows[0].metric_version_id, metric.version.id, 'a versão vigente na data');
  assert.match(rows[0].calc_hash, /^[0-9a-f]{64}$/, 'grava o hash do cálculo');
  assert.equal(rows[0].captured_late, false);
  assert.equal(result.days[0].counts.written, 1);
});

test('m9d609 o snapshot grava source_refs de buildSourceRefs, com filterHash e count', async () => {
  const [row] = await rowsOf(metric.code);
  assert.ok(row.source_refs.length >= 1);
  for (const ref of row.source_refs) {
    assert.match(ref.filterHash, /^[0-9a-f]{64}$/);
    assert.ok(Number.isInteger(ref.count));
    assert.ok(ref.filterSignature);
  }
});

test('m9d609 snapshot sem source_refs válido é recusado e vira falha da métrica, sem impedir as outras', async () => {
  const other = await e.publish(env, tenant);
  const failed = [];
  const stop = onSnapshotFailed((p) => failed.push(p));
  const off2 = providers.registerSnapshotProvider({
    name: 'm9d609-sem-refs', metricCodes: [other.code],
    async build(sc, asOfDate) {
      return [{ code: other.code, inputs: [{
        metricId: other.definition.id, metricVersionId: other.version.id, companyId: sc.companyId, groupId: sc.groupId, scopeType: 'COMPANY', scopeId: sc.companyId,
        periodStart: asOfDate, periodEnd: asOfDate, asOfDate, valueNumeric: '1.0000', status: 'OK', sourceSnapshotAt: `${asOfDate}T20:00:00Z`, sourceRefs: [], calcHash: e.sha('x'),
      }] }];
    },
  });
  await clearDays();
  await clearSnaps(metric.definition.id);
  const result = await run('2026-10-30T03:30:00Z');
  off2();
  stop();
  assert.equal(result.days[0].status, 'PARTIAL', 'o dia fica PARTIAL para ser refeito');
  assert.equal(result.days[0].counts.failed, 1);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].metricCode, other.code);
  assert.equal(failed[0].errorCode, 'ANALYTICS_SNAPSHOT_SOURCE_REFS_REQUIRED');
  assert.equal((await rowsOf(metric.code)).length, 1, 'a outra métrica foi gravada mesmo assim');
  assert.deepEqual(await rowsOf(other.code), []);
});

test('m9d609 job executado duas vezes não duplica', async () => {
  await clearDays();
  await clearSnaps(metric.definition.id);
  await run('2026-10-30T03:30:00Z');
  const again = await run('2026-10-30T04:10:00Z');
  assert.deepEqual(again.days, [], 'dia COMPLETED não volta a ser processado');
  assert.equal((await rowsOf(metric.code)).length, 1);
  // mesmo com o diário apagado (job sem memória), o snapshot existente não é regravado nem alterado
  const before = await rowsOf(metric.code);
  await clearDays();
  const third = await run('2026-10-30T05:00:00Z');
  assert.equal(third.days[0].counts.written, 0);
  assert.equal(third.days[0].counts.existing, 1);
  assert.deepEqual(await rowsOf(metric.code), before);
});

test('m9d609 dois jobs simultâneos disputam o dia e o segundo ignora', async () => {
  await clearDays();
  await clearSnaps(metric.definition.id);
  const [a, b] = await Promise.all([run('2026-10-30T03:30:00Z'), run('2026-10-30T03:30:00Z')]);
  const claimed = [a, b].map((r) => r.days.filter((d) => d.claimed).length);
  assert.deepEqual(claimed.sort(), [0, 1], 'um dos dois detém o dia');
  assert.equal((await rowsOf(metric.code)).length, 1);
});

test('m9d609 snapshot imutável sem rebuild', async () => {
  const [row] = await rowsOf(metric.code);
  await assert.rejects(env.admin.query('UPDATE analytics.metric_snapshots SET value_numeric = 999 WHERE metric_id = :id', { replacements: { id: metric.definition.id } }), /imut|ANA03|não pode/i);
  await clearDays();
  await run('2026-10-30T06:00:00Z'); // reexecução não revisa o passado
  const after = await rowsOf(metric.code);
  assert.equal(after.length, 1);
  assert.equal(after[0].revision_no, row.revision_no);
  assert.equal(String(after[0].value_numeric), String(row.value_numeric));
});

test('m9d609 consulta histórica devolve versão da época', async () => {
  const hist = await e.publish(env, tenant, { validFrom: '2026-01-01' });
  await e.snapshot(tenant, { ...hist, asOfDate: '2026-09-30', sourceSnapshotAt: '2026-09-30T12:00:00Z', refreshedAt: '2026-09-30T12:05:00Z', value: '30.0000' });
  e.at('2026-10-29T15:00:00Z');
  const v2 = await e.sup.inTx(tenant, { commit: true }, (tx) => e.registry.publishVersion(hist.code, {
    version: 2, validFrom: '2026-10-29', formulaSemantic: 'Soma dos saldos disponíveis menos as obrigações do período, versão 2.', changeReason: 'Mudança de regra para o teste de histórico.',
  }, e.sup.ctxOf(tenant), tx, { catalog: env.catalog }));
  assert.equal(v2.version.version, 2);
  await e.snapshot(tenant, { definition: hist.definition, version: v2.version, asOfDate: '2026-10-29', sourceSnapshotAt: '2026-10-29T14:00:00Z', refreshedAt: '2026-10-29T14:05:00Z', value: '77.0000' });
  assert.equal((await e.readAsOf(tenant, hist.code, '2026-10-29')).version, 2, 'hoje vale a versão 2');
  const old = await e.readAsOf(tenant, hist.code, '2026-09-30');
  assert.equal(old.version, 1, 'a versão da época, não a vigente hoje');
  assert.equal(old.historical, true);
  assert.equal(old.value, '30.0000');
  await assert.rejects(e.readAsOf(tenant, hist.code, '2026-09-29'), (err) => err.statusCode === 404 && err.code === 'ANALYTICS_SNAPSHOT_NOT_AVAILABLE' && err.message === 'Não há registro desse indicador nessa data.');
});

test('m9d609 catch-up grava captured_late true', async () => {
  await clearDays();
  await clearSnaps(metric.definition.id);
  // o job rodou até 27/10 e ficou parado em 28/10 e 29/10; é retomado em 30/10 às 00:30
  await env.admin.query("INSERT INTO analytics.snapshot_job_runs (company_id, group_id, as_of_date, status, finished_at) VALUES (:c, :g, '2026-10-27', 'COMPLETED', now())", { replacements: { c: tenant.companyId, g: tenant.groupId } });
  const result = await run('2026-10-30T03:30:00Z');
  assert.deepEqual(result.days.map((d) => d.asOfDate), ['2026-10-28', '2026-10-29']);
  const rows = await rowsOf(metric.code);
  assert.deepEqual(rows.map((r) => [r.d, r.captured_late]), [['2026-10-28', true], ['2026-10-29', true]], 'os dois dias saem atrasados, inclusive o D-1');
  const [runs] = await env.admin.query('SELECT as_of_date::text AS d, captured_late, status FROM analytics.snapshot_job_runs WHERE company_id = :c ORDER BY as_of_date', { replacements: { c: tenant.companyId } });
  assert.deepEqual(runs.map((r) => [r.d, r.status]), [['2026-10-27', 'COMPLETED'], ['2026-10-28', 'COMPLETED'], ['2026-10-29', 'COMPLETED']]);
});

test('m9d609 catch-up não vai além do limite de dias configurado e dia sem linha no read model não vira snapshot', async () => {
  await clearDays();
  await clearSnaps(metric.definition.id);
  await env.admin.query("INSERT INTO analytics.snapshot_job_runs (company_id, group_id, as_of_date, status, finished_at) VALUES (:c, :g, '2026-10-20', 'COMPLETED', now())", { replacements: { c: tenant.companyId, g: tenant.groupId } });
  await e.setSetting(env, tenant, 'analytics.snapshot.dias_retroativos_max', 4);
  const result = await run('2026-10-30T03:30:00Z');
  assert.deepEqual(result.days.map((d) => d.asOfDate), ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29'], 'só os 4 últimos dias');
  const rows = await rowsOf(metric.code);
  assert.deepEqual(rows.map((r) => r.d), ['2026-10-27', '2026-10-28', '2026-10-29'], '26/10 não tinha linha no read model: nada inventado');
  assert.equal(result.days[0].counts.withoutSource, 1);
  await assert.rejects(e.readAsOf(tenant, metric.code, '2026-10-26'), (err) => err.code === 'ANALYTICS_SNAPSHOT_NOT_AVAILABLE');
});

test('m9d609 a hora do snapshot é parâmetro do administrador', async () => {
  await clearDays();
  await clearSnaps(metric.definition.id);
  await e.setSetting(env, tenant, 'analytics.snapshot.hora_execucao', '02:00');
  assert.equal((await run('2026-10-30T03:30:00Z')).ran, false, '00:30 em São Paulo: ainda antes das 02:00');
  assert.equal((await run('2026-10-30T05:00:00Z')).ran, true, '02:00 em São Paulo');
});
