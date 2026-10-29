'use strict';

// M9-D661 — cor.commission: as três séries (esperada, confirmada, recebida) refeitas do zero só com os direitos de comissão da fonte, nunca somadas, a diferença
// a receber e a regra de qualidade (comissão recebida sem lançamento ou caso vinculado).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const kit = require('../_helpers/legalCorEnv');
const sc = require('../_helpers/m9d661Scenario');
const oracle = require('../_helpers/m9d661Oracle');
const money = require('../../../src/features/analytics/metrics/formulas/money');

let env;
let ids;
const refresh = (t, id) => kit.apply(t, kit.makeEvent(t, 'commission.confirmed', { id }));
const same = (a, b, msg) => assert.equal(money.cmp(a, b), 0, `${msg || ''} ${a} x ${b}`);
before(async () => {
  env = await kit.setup();
  const cases = await sc.casos(env, env.cX);
  ids = await sc.comissoes(env, env.cX, cases.decided[0]);
  await kit.refreshAll(env.cX);
  await kit.kpis(env.cX);
});
after(() => kit.teardown(env));

test('m9d661 reproduz cor.commission a partir dos registros-fonte', async () => {
  const want = await oracle.commissionFromSource(env, env.cX);
  assert.deepEqual([want.expected, want.confirmed, want.received, want.toReceive], ['96000.00', '54000.00', '31000.00', '23000.00'], 'exemplo do livro');
  const kpi = await kit.readKpi(env.cX, 'cor.commission');
  assert.deepEqual([kpi.status, kpi.unit, kpi.version, kpi.metricCode, kpi.valueNature], ['OK', 'BRL', 1, 'cor.commission', 'ESTIMATED']);
  same(kpi.value, want.expected, 'esperada');
  same(await kit.dimension(env.cX, 'cor.commission', 'confirmada_brl'), want.confirmed, 'confirmada');
  same(await kit.dimension(env.cX, 'cor.commission', 'recebida_brl'), want.received, 'recebida');
  same(await kit.dimension(env.cX, 'cor.commission', 'a_receber_brl'), want.toReceive, 'a receber');
  same(await kit.dimension(env.cX, 'cor.commission', 'provider:BANCO_A:confirmada_brl'), '43000.00', 'provider A: 13.000 + 10.000 + 20.000');
  assert.equal(kpi.sourceRefs[0].table, 'correspondent.commission_entitlements');
  same(await sumOfDetail(kpi), want.expected, 'o detalhe soma o valor do KPI');
});

async function sumOfDetail(kpi) {
  const { openDrilldown } = require('../../../src/features/analytics/metrics/drilldown.service');
  const ref = kpi.sourceRefs[0];
  return kit.inTx(env.cX, {}, async (tx) => {
    const ctx = kit.ctxOf(env.cX, ['analytics:read', 'analytics:drilldown', 'correspondent:read']);
    const rows = [];
    let page = 1;
    let body;
    do {
      body = await openDrilldown(ctx, { metricCode: 'cor.commission', filter: ref.filter, filterHash: ref.filterHash, filterSignature: ref.filterSignature, page, pageSize: 1, route: 'teste' }, tx);
      rows.push(...body.rows);
      page += 1;
    } while (page <= body.totalPages);
    assert.equal(body.reconcileMode, 'SUM');
    return money.sum(rows.map((r) => r.contribution));
  });
}

test('m9d661 cor.commission mantém esperada (ESTIMATED), confirmada (PLANNED) e recebida (ACTUAL) como séries separadas e nunca somadas', async () => {
  const result = (await kit.kpis(env.cX)).cor.kpis['cor.commission'];
  assert.deepEqual(result.details.series.map((s) => [s.valueNature, s.total]), [['ACTUAL', '31000.00'], ['PLANNED', '54000.00'], ['ESTIMATED', '96000.00']]);
  assert.equal(result.value, '96000.00', 'o valor do indicador é só a esperada');
  assert.equal(result.details.toReceive, '23000.00', 'a diferença confirmada − recebida');
  assert.ok(!JSON.stringify(result).includes('181000'), 'não existe total das três séries (96.000 + 54.000 + 31.000)');
});

test('m9d661 cor.commission: o direito ajustado nunca conta e a mudança de status move o valor entre as séries', async () => {
  const t = env.cX;
  const before = await oracle.commissionFromSource(env, t);
  await kit.update(env, 'correspondent.commission_entitlements', ids.confirmed, { status: 'RECEIVABLE' }); // continua confirmada, nada muda
  await refresh(t, ids.confirmed);
  await kit.kpis(t);
  same(await kit.dimension(t, 'cor.commission', 'confirmada_brl'), before.confirmed);
  await kit.update(env, 'correspondent.commission_entitlements', ids.expected, { status: 'CONFIRMED' }); // a esperada de 60.000 foi confirmada pelo banco
  await refresh(t, ids.expected);
  await kit.kpis(t);
  const after2 = await oracle.commissionFromSource(env, t);
  same(after2.expected, '36000.00');
  same((await kit.readKpi(t, 'cor.commission')).value, after2.expected, 'esperada caiu');
  same(await kit.dimension(t, 'cor.commission', 'confirmada_brl'), after2.confirmed, 'confirmada subiu');
  same(after2.confirmed, money.add(before.confirmed, '60000.00'));
  await kit.update(env, 'correspondent.commission_entitlements', ids.expected, { status: 'EXPECTED' });
  await refresh(t, ids.expected);
  await kit.kpis(t);
});

test('m9d661 cor.commission fica DEGRADED com valor nulo quando a regra de qualidade falha (comissão recebida sem lançamento ou caso vinculado)', async () => {
  const t = env.cY;
  const cases = await sc.casos(env, t);
  await sc.comissoes(env, t, cases.decided[0]);
  await kit.refreshAll(t);
  assert.equal((await kit.kpis(t)).cor.kpis['cor.commission'].status, 'OK');
  await kit.seed(env, t, 'correspondent.commission_entitlements', { // recebida, mas sem nenhum lançamento liquidado vinculado
    financing_case_id: cases.decided[0], provider_code: 'BANCO_A', status: 'RECEIVED', base_amount: '1.00', percentage: '1.00', amount: '5.00', broker_share_pct: '100', manager_share_pct: '0',
    broker_amount: '5.00', manager_amount: '0.00', trigger_event: 'APPROVED', created_at: sc.at('10-01'), updated_at: sc.at('10-01'),
  });
  await refresh(t, cases.decided[0]);
  const result = (await kit.kpis(t)).cor.kpis['cor.commission'];
  assert.deepEqual([result.status, result.value, result.details.reason, result.details.receivedUnlinked], ['DEGRADED', null, 'RECEBIDA_SEM_CASO_VINCULADO', '1']);
  assert.equal((await kit.readKpi(t, 'cor.commission')).value, null, 'nunca um número enganoso');
});
