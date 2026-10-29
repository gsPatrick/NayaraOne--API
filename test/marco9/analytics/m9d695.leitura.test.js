'use strict';

// M9-D695 — as sete ferramentas executam com a permissão do usuário e o RLS da empresa, devolvem números já gravados, nunca campos RESTRICTED
// e registram cada consulta (NAY_QUERY). Banco descartável; cada teste roda em transação com rollback.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env695 = require('../_helpers/m9d695Env');
const { TenantSetting } = require('../../../src/models');
const clock = require('../../../src/features/analytics/metrics/clock');
const { createNayAnalytics } = require('../../../src/features/analytics/briefs');

const { inTx, callTool, metricWithSnapshots, asTenant, FINANCE_USER } = env695;
let env;
before(async () => { env = await env695.setup(); clock.setClock(() => new Date('2026-10-28T15:00:00Z')); });
after(async () => { clock.resetClock(); await env695.teardown(env); });

const SNAPSHOTS = [
  { periodStart: '2026-09-01', periodEnd: '2026-09-30', asOfDate: '2026-09-30', value: '100.00' },
  { periodStart: '2026-10-01', periodEnd: '2026-10-31', asOfDate: '2026-10-28', value: '125.50', sourceSnapshotAt: '2026-10-28T14:30:00Z' },
];
const scopeOf = (tenant, permissions) => ({ groupId: tenant.groupId, companyId: tenant.companyId, userId: tenant.userId, permissions: ['analytics:read'], userPermissions: permissions });
const run = (tenant, permissions, tx) => createNayAnalytics(tx, scopeOf(tenant, permissions));
const rejects = async (promise, status, code) => {
  const err = await promise.then(() => null, (e) => e);
  assert.ok(err, `deveria recusar com ${code}`);
  assert.equal(err.statusCode, status, `${err.code}: ${err.message}`);
  assert.equal(err.code, code);
  return err;
};

test('m9d695 ferramenta aplica permissão do usuário e RLS', async () => {
  await inTx(env.tenantA, {}, async (tx) => {
    const { definition } = await metricWithSnapshots(env, env.tenantA, tx, { snapshots: SNAPSHOTS });
    const code = definition.metric_code;
    // com a permissão do BI e a do domínio financeiro: o número gravado, sem conta nenhuma da NAY
    const ok = await callTool(env, env.tenantA, tx, FINANCE_USER, 'analytics.getMetric', { metricCode: code, period: '2026-10' });
    assert.equal(ok.status, 'SUCCEEDED');
    assert.deepEqual([ok.output.metricCode, ok.output.value, ok.output.unit, ok.output.status, ok.output.version], [code, '125.5', 'BRL', 'OK', 1].map((v, i) => (i === 1 ? ok.output.value : v)));
    assert.equal(Number(ok.output.value), 125.5);
    assert.equal(ok.output.period.asOfDate, '2026-10-28', 'período corrente: a data-base é hoje');
    assert.equal(ok.output.freshness.asOfDate, '2026-10-28');
    // sem a permissão do domínio financeiro: 403 e nenhum número
    await rejects(run(env.tenantA, ['analytics:read'], tx).getMetric({ metricCode: code, period: '2026-10' }), 403, 'ANALYTICS_DRILLDOWN_FORBIDDEN');
    await rejects(run(env.tenantA, ['analytics:read', 'crm:opportunities:read'], tx).getMetricBreakdown({ metricCode: code, period: '2026-10', dimension: 'company' }), 403, 'ANALYTICS_DRILLDOWN_FORBIDDEN');
    // sem a permissão do BI: o pipeline barra antes da ferramenta
    const semBi = await callTool(env, env.tenantA, tx, ['finance:read'], 'analytics.getMetric', { metricCode: code, period: '2026-10' }).then(() => null, (e) => e);
    assert.equal(semBi.statusCode, 403);
    // outra empresa (RLS): o número gravado na A não existe para a B
    await asTenant(tx, env.tenantB);
    await rejects(run(env.tenantB, FINANCE_USER, tx).getMetric({ metricCode: code, period: '2026-10' }), 404, 'ANALYTICS_METRIC_NOT_FOUND');
    await asTenant(tx, env.tenantA);
    // empresa pedida de outro grupo ou inexistente: 404, nunca 403
    await rejects(run(env.tenantA, FINANCE_USER, tx).getMetric({ metricCode: code, period: '2026-10', companyId: '00000000-0000-4000-8000-000000000001' }), 404, 'ANALYTICS_SCOPE_NOT_FOUND');
    await rejects(run(env.tenantA, FINANCE_USER, tx).getFreshness({ metricCode: code, companyId: 'nao-e-uuid' }), 404, 'ANALYTICS_SCOPE_NOT_FOUND');
    // cada consulta bem-sucedida deixa a linha NAY_QUERY no log de acesso, com o usuário e a ferramenta
    const [log] = await env.admin.query("SELECT user_id, resource_code, route, rows_returned FROM analytics.access_log WHERE action = 'NAY_QUERY' AND resource_code = :c", { replacements: { c: code } });
    assert.ok(log.length >= 1);
    assert.equal(log[0].user_id, env.tenantA.userId);
    assert.equal(log[0].route, 'nay:getMetric');
  });
});

test('m9d695 getMetric, variação, freshness e períodos', async () => {
  await inTx(env.tenantA, {}, async (tx) => {
    const { definition } = await metricWithSnapshots(env, env.tenantA, tx, { snapshots: SNAPSHOTS });
    const code = definition.metric_code;
    const bi = run(env.tenantA, FINANCE_USER, tx);
    const sep = await bi.getMetric({ metricCode: code, period: '2026-09' });
    assert.equal(Number(sep.value), 100);
    assert.equal(sep.period.asOfDate, '2026-09-30', 'período encerrado: a data-base é o último dia');
    const v = await bi.getMetricVariation({ metricCode: code, periodA: '2026-09', periodB: '2026-10' });
    assert.deepEqual([Number(v.valueA), Number(v.valueB), v.delta, v.deltaPercent], [100, 125.5, '25.5000', '25.50']);
    const down = await bi.getMetricVariation({ metricCode: code, periodA: '2026-10', periodB: '2026-09' });
    assert.deepEqual([down.delta, down.deltaPercent], ['-25.5000', '-20.32']);
    await rejects(bi.getMetric({ metricCode: code, period: '2026-08' }), 404, 'ANALYTICS_SNAPSHOT_NOT_AVAILABLE');
    await rejects(bi.getMetric({ metricCode: code, period: '2027-02' }), 400, 'ANALYTICS_AS_OF_FUTURE');
    await rejects(bi.getMetric({ metricCode: code, period: '2026-13' }), 400, 'ANALYTICS_PERIOD_INVALID');
    await rejects(bi.getMetric({ metricCode: 'fin.nao_existe', period: '2026-10' }), 404, 'ANALYTICS_METRIC_NOT_FOUND');
    const fresh = await bi.getFreshness({ metricCode: code });
    assert.deepEqual([fresh.hasData, fresh.asOfDate, fresh.status], [true, '2026-10-28', 'OK']);
    assert.ok(Number.isInteger(fresh.ageMinutes) && fresh.ageMinutes >= 0);
    const semDados = await metricWithSnapshots(env, env.tenantA, tx, { snapshots: [] });
    assert.deepEqual(await bi.getFreshness({ metricCode: semDados.definition.metric_code }).then((r) => [r.hasData, r.asOfDate, r.ageMinutes]), [false, null, null]);
    assert.equal(env695.sup.codeOf().startsWith('fin.'), true);
  });
});

test('m9d695 decomposição por dimensão declarada, com limite configurável e sem campo RESTRICTED', async () => {
  await inTx(env.tenantA, {}, async (tx) => {
    const base = { periodStart: '2026-10-01', periodEnd: '2026-10-31', asOfDate: '2026-10-28' };
    const { definition } = await metricWithSnapshots(env, env.tenantA, tx, {
      dimensions: ['setor'],
      snapshots: [
        { ...base, value: '300.00' },
        { ...base, dimensionKey: 'setor=Vendas', value: '200.00' },
        { ...base, dimensionKey: 'setor=Locação', value: '100.00' },
        { ...base, dimensionKey: 'setor=529.982.247-25', value: '1.00' }, // CPF no valor da dimensão: sai mascarado
        { ...base, dimensionKey: 'outra=X', value: '9.00' },
      ],
    });
    const code = definition.metric_code;
    const out = await callTool(env, env.tenantA, tx, FINANCE_USER, 'analytics.getMetricBreakdown', { metricCode: code, period: '2026-10', dimension: 'setor' });
    const values = out.output.items.map((i) => i.dimensionValue);
    assert.deepEqual(values.slice().sort(), ['***.982.247-**', 'Locação', 'Vendas'].sort());
    assert.ok(!JSON.stringify(out.output).includes('529.982.247-25'), 'o CPF original nunca sai');
    assert.equal(out.output.truncated, false);
    assert.equal(Number(out.output.items.find((i) => i.dimensionValue === 'Vendas').value), 200);
    await rejects(run(env.tenantA, FINANCE_USER, tx).getMetricBreakdown({ metricCode: code, period: '2026-10', dimension: 'inexistente' }), 422, 'ANALYTICS_DIMENSION_NOT_DECLARED');
    // limite de itens vem da configuração do administrador (analytics.nay.max_itens_resposta)
    await TenantSetting.create({ groupId: env.tenantA.groupId, companyId: env.tenantA.companyId, key: 'analytics.nay.max_itens_resposta', value: 2 }, { transaction: tx });
    const cut = await run(env.tenantA, FINANCE_USER, tx).getMetricBreakdown({ metricCode: code, period: '2026-10', dimension: 'setor' });
    assert.deepEqual([cut.items.length, cut.truncated], [2, true]);
  });
});
