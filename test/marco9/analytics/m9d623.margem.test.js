'use strict';

// M9-D623 — KPI fin.sector_margin: reprodução a partir dos registros-fonte (receita, custo, margem e percentual por setor), qualidade (lançamento sem
// setor, receita zero), competência de São Paulo e parâmetro do limite.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const envK = require('../_helpers/finKpiEnv');
const sc = require('../_helpers/m9d623Scenario');
const { marginFromSource } = require('../_helpers/m9d623Oracle');
const money = require('../../../src/features/analytics/metrics/formulas/money');
require('../../../src/features/analytics');

const { kpis, readKpi, setSetting } = envK;
const CODE = 'fin.sector_margin';
const dim = async (t, key) => (await readKpi(t, CODE, { dimensionKey: key })).value;
const same = (a, b, msg) => assert.equal(money.cmp(a, b), 0, `${msg}: ${a} x ${b}`);
let env;
before(async () => { env = await envK.setup(); });
after(() => envK.teardown(env));

test('m9d623 reproduz fin.sector_margin a partir dos registros-fonte', async () => {
  const t = env.cX;
  await sc.seedMargin(env, t);
  await sc.refreshMargin(t);
  await kpis(t);
  const want = await marginFromSource(env, t, sc.MONTH);
  assert.deepEqual([want.sectors[sc.CENTER.locacao].margin, want.sectors[sc.CENTER.locacao].pct], ['28000.00', '35.00'], 'exemplo do livro: Locação 28.000,00 e 35,00%');
  assert.deepEqual([want.sectors[sc.CENTER.vendas].margin, want.sectors[sc.CENTER.vendas].pct], ['38500.00', '38.50'], 'Vendas 38,50%');
  const main = await readKpi(t, CODE);
  same(main.value, want.total, 'margem total');
  assert.deepEqual([main.status, main.unit, main.version, main.valueNature], ['OK', 'BRL', 1, 'ACTUAL']);
  for (const [id, s] of Object.entries(want.sectors)) {
    same(await dim(t, `setor:${id}:receita_brl`), s.revenue, `receita ${id}`);
    same(await dim(t, `setor:${id}:custo_brl`), s.cost, `custo ${id}`);
    same(await dim(t, `setor:${id}:margem_brl`), s.margin, `margem ${id}`);
    same(await dim(t, `setor:${id}:margem_pct`), s.pct, `percentual ${id}`);
  }
  assert.equal((await readKpi(t, CODE, { dimensionKey: `setor:${sc.CENTER.locacao}:margem_pct` })).unit, 'PERCENT', 'a dimensão de percentual tem unidade PERCENT');
  assert.equal((await readKpi(t, CODE, { dimensionKey: `setor:${sc.CENTER.locacao}:margem_brl` })).unit, 'BRL');
});

test('m9d623 fin.sector_margin fica DEGRADED com valor nulo quando a regra de qualidade falha', async () => {
  const t = env.cY;
  // 1.000,00 de receita e 0 de custo sem setor, num total de 80.000 + 52.000: 0,75% (abaixo de 1%): ainda OK
  await sc.seedMargin(env, t, { withoutCenter: { revenue: '1000.00', cost: '0.00' } });
  await sc.refreshMargin(t);
  await kpis(t);
  const ok = await readKpi(t, CODE);
  assert.equal(ok.status, 'OK', 'sem setor abaixo do limite padrão de 1%');
  assert.ok((await dim(t, 'sem_setor_pct')) !== null);
  // acima de 1%: mais 2.000,00 de custo sem setor
  await sc.entry(env, t, { nature: 'PAYABLE', amount: '2000.00', center: null });
  await sc.refreshMargin(t, [null]);
  await kpis(t);
  const bad = await readKpi(t, CODE);
  assert.equal(bad.status, 'DEGRADED');
  assert.equal(bad.value, null, 'valor nulo, nunca número enganoso');
  same(await dim(t, 'setor:sem_setor:custo_brl'), '2000.00', 'o que foi classificado e o "Sem setor" continuam visíveis');
  // o limite é parâmetro do administrador: 5% volta a aceitar
  await setSetting(env, t, 'analytics.qualidade.max_sem_setor_pct', 5);
  await sc.refreshMargin(t, [null]);
  await kpis(t);
  assert.equal((await readKpi(t, CODE)).status, 'OK', 'com o limite em 5% o mesmo dado é aceito');
});

test('m9d623 receita zero: percentual nulo, status INCOMPLETE e o valor da margem continua exibido', async () => {
  const [t, center] = [env.cX, '33333333-3333-4333-8333-333333333333'];
  await sc.entry(env, t, { nature: 'PAYABLE', amount: '100.00', center, month: '2026-08' });
  await envK.refreshEntries(t, { resultCenterId: center, competenceMonth: '2026-08' });
  // o mês de competência é o do dia-base (outubro): agosto não entra, o indicador de outubro segue OK
  assert.equal((await readKpi(t, CODE)).status, 'OK');
  const formula = require('../../../src/features/analytics/metrics/formulas/finSectorMargin');
  const out = formula.compute({ asOfDate: '2026-10-28', competenceMonth: '2026-10', sectors: [{ id: center, revenue: '0', cost: '100.00' }] }, { maxNoSectorPct: '1' });
  assert.deepEqual([out.status, out.value], ['INCOMPLETE', '-100.00']);
  assert.equal(out.dimensions.some((d) => d.key.endsWith('margem_pct')), false, 'sem receita não há percentual');
  assert.equal(out.details.sectors[0].marginPct, null);
});

test('m9d623 timezone: lançamento às 23:30 de São Paulo cai no mês de competência certo', async () => {
  // a competência é gravada no lançamento (mês de São Paulo): uma liquidação em 31/10 às 23:30 (01/11 02:30Z) segue na competência de outubro
  const t = env.cX;
  await envK.ledger.insert(env, 'financial_entries', t, {
    entry_type: 'CREDIT', nature: 'RECEIVABLE', amount: '10.00', status: 'SETTLED', settled_at: '2026-11-01T02:30:00.000Z', due_at: '2026-11-01T02:30:00.000Z',
    is_third_party_funds: false, result_center_id: sc.CENTER.locacao, competence_month: sc.MONTH,
  });
  await sc.refreshMargin(t, [sc.CENTER.locacao]);
  await kpis(t);
  const want = await marginFromSource(env, t, sc.MONTH);
  same(await dim(t, `setor:${sc.CENTER.locacao}:receita_brl`), want.sectors[sc.CENTER.locacao].revenue, 'receita de Locação');
  same(want.sectors[sc.CENTER.locacao].revenue, '80010.00', 'a receita das 23:30 de 31/10 entrou em outubro');
});

test('m9d623 isolamento entre empresas no KPI', async () => {
  const [x, y] = [env.cX, env.cY];
  same((await readKpi(x, CODE)).value, (await marginFromSource(env, x, sc.MONTH)).total, 'a empresa X só vê os próprios setores');
  assert.ok(await dim(y, 'setor:sem_setor:custo_brl') !== undefined);
  await assert.rejects(
    envK.inTx(y, {}, (tx) => require('../../../src/features/analytics/metrics').readMetricAsOf(envK.ctxOf(y), { metricCode: CODE, scopeType: 'COMPANY', scopeId: x.companyId, asOfDate: env.asOf }, tx)),
    (e) => e.statusCode === 404, 'o escopo de outra empresa não devolve nada (RLS)'
  );
});

test('m9d623 replay do mesmo evento não altera o valor', async () => {
  const t = env.cX;
  const asserts = require('../_helpers/readModelAsserts');
  const event = { ...envK.event(t, 'finance.entry.settled'), payloadJson: { id: envK.ledger.uuid(), resultCenterId: sc.CENTER.vendas, competenceMonth: sc.MONTH } };
  const read = async () => ({
    sector: (await env.admin.query('SELECT result_center_id, competence_month, revenue_actual::text AS r, cost_actual::text AS c FROM analytics.rm_finance_sector_margin WHERE company_id = :c ORDER BY 1, 2', { replacements: { c: t.companyId } }))[0],
    snapshots: (await env.admin.query("SELECT s.dimension_key, s.revision_no, s.value_numeric::text AS v FROM analytics.metric_snapshots s JOIN analytics.metric_definitions d ON d.id = s.metric_id WHERE s.company_id = :c AND d.metric_code = 'fin.sector_margin' ORDER BY 1, 2", { replacements: { c: t.companyId } }))[0],
  });
  await asserts.assertReplayIdempotent({ applyEvent: () => envK.inTx(t, { commit: true }, (tx) => require('../../../src/features/analytics/read-models').applyEvent(event, tx, { now: envK.NOW })), readRow: read });
});
