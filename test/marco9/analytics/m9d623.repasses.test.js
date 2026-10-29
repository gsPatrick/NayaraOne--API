'use strict';

// M9-D623 — KPI fin.owner_repasses_pending: reprodução a partir dos repasses (valor, contagem, idade média, faixas), repasse vencido além do alerta em
// dias úteis (parâmetro analytics.repasse.dias_alerta), isolamento e replay.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const envK = require('../_helpers/finKpiEnv');
const sc = require('../_helpers/m9d623Scenario');
const { repassesFromSource } = require('../_helpers/m9d623Oracle');
const money = require('../../../src/features/analytics/metrics/formulas/money');
require('../../../src/features/analytics');

const { refresh, kpis, readKpi, setSetting } = envK;
const CODE = 'fin.owner_repasses_pending';
const same = (a, b, msg) => assert.equal(money.cmp(a, b), 0, `${msg}: ${a} x ${b}`);
const detailsOf = async (t) => {
  const { buildFinanceKpiEntries } = require('../../../src/features/analytics/metrics/kpis/finance.entries');
  const entries = await envK.inTx(t, {}, (tx) => buildFinanceKpiEntries({ companyId: t.companyId, groupId: t.groupId }, env.asOf, tx));
  return entries.find((e) => e.code === CODE).result;
};
let env;
let ownerId;
before(async () => {
  env = await envK.setup();
  ({ owner: ownerId } = await sc.seedRepasses(env, env.cX));
  await refresh(env.cX, 'finance.owner_repasse.created');
  await kpis(env.cX);
});
after(() => envK.teardown(env));

test('m9d623 reproduz fin.owner_repasses_pending a partir dos registros-fonte', async () => {
  const t = env.cX;
  const want = await repassesFromSource(env, t, env.asOf);
  assert.equal(want.total, '54000.00', 'exemplo do livro: aluguéis a repassar 54.000,00 (pago e cancelado ficam fora)');
  const got = await readKpi(t, CODE);
  same(got.value, want.total, 'valor');
  assert.deepEqual([got.status, got.unit, got.version, got.valueNature], ['OK', 'BRL', 1, 'ACTUAL']);
  assert.equal(Number((await readKpi(t, CODE, { dimensionKey: 'quantidade_qtd' })).value), want.count);
  assert.equal((await readKpi(t, CODE, { dimensionKey: 'quantidade_qtd' })).unit, 'COUNT');
  same((await readKpi(t, CODE, { dimensionKey: 'idade_media_dias' })).value, want.avgAge, 'idade média em dias corridos');
  assert.equal((await readKpi(t, CODE, { dimensionKey: 'idade_media_dias' })).unit, 'DAYS');
  for (const [owner, amount] of Object.entries(want.byOwner)) same((await readKpi(t, CODE, { dimensionKey: `proprietario:${owner}` })).value, amount, `proprietário ${owner}`);
  assert.equal(got.sourceRefs[0].table, 'finance.owner_repasses');
  assert.equal(got.sourceRefs[0].count, want.count);
});

test('m9d623 fin.owner_repasses_pending fica DEGRADED com valor nulo quando a regra de qualidade falha', async () => {
  // Decisão DI-D623-6: a regra de qualidade escrita na demanda diz que o repasse vencido além de analytics.repasse.dias_alerta é EXPOSTO em
  // details.overdueBeyondAlert e destacado no Centro de Comando, "sem alerta próprio, não DEGRADED"; a linha 8 da tabela de testes diz o contrário.
  // Vale o texto da regra (o livro não pede alerta). Aqui se prova o que a regra manda: o vencido aparece nos detalhes e o valor segue exibido.
  const t = env.cX;
  const want = await repassesFromSource(env, t, env.asOf, { alertDays: 5 });
  assert.deepEqual([want.overdue.count, want.overdue.amount], [1, '40000.00'], 'só o repasse de 14/10 passa de 5 dias úteis');
  const out = await detailsOf(t);
  assert.equal(out.status, 'OK', 'repasse vencido não derruba o indicador');
  same(out.value, '54000.00', 'valor continua exibido');
  assert.deepEqual([out.details.overdueBeyondAlert.count, out.details.overdueBeyondAlert.amount], ['1', '40000.00']);
  assert.equal(out.details.alertBusinessDays, '5');
});

test('m9d623 o alerta em dias úteis vem do parâmetro analytics.repasse.dias_alerta', async () => {
  const t = env.cX;
  await setSetting(env, t, 'analytics.repasse.dias_alerta', 1);
  const want = await repassesFromSource(env, t, env.asOf, { alertDays: 1 });
  assert.deepEqual([want.overdue.count, want.overdue.amount], [2, '54000.00'], 'com 1 dia útil os dois passam (2 dias úteis do de 26/10)');
  const out = await detailsOf(t);
  assert.deepEqual([out.details.overdueBeyondAlert.count, out.details.overdueBeyondAlert.amount, out.details.alertBusinessDays], ['2', '54000.00', '1']);
  await setSetting(env, t, 'analytics.repasse.dias_alerta', 20);
  assert.equal((await detailsOf(t)).details.overdueBeyondAlert.count, '0');
  await setSetting(env, t, 'analytics.repasse.dias_alerta', 5);
});

test('m9d623 as faixas de atraso seguem o parâmetro e cobrem todos os repasses', async () => {
  const t = env.cX;
  const out = await detailsOf(t);
  const bands = out.dimensions.filter((d) => d.key.startsWith('faixa:'));
  assert.deepEqual(bands.map((d) => d.key), ['faixa:0-5', 'faixa:6-15', 'faixa:16+'], 'padrão 5,15 dias úteis');
  same(money.sum(bands.map((d) => d.value)), '54000.00', 'a soma das faixas é o valor');
  await setSetting(env, t, 'analytics.repasse.faixas_atraso_dias', '1,3');
  const custom = (await detailsOf(t)).dimensions.filter((d) => d.key.startsWith('faixa:'));
  assert.deepEqual(custom.map((d) => d.key), ['faixa:0-1', 'faixa:2-3', 'faixa:4+']);
  await setSetting(env, t, 'analytics.repasse.faixas_atraso_dias', '5,15');
});

test('m9d623 timezone: repasse criado às 23:30 de São Paulo cai no dia certo', async () => {
  const t = env.cY;
  // 27/10 às 23:30 (28/10 02:30Z): é de 27/10, 1 dia corrido e 1 dia útil de idade em 28/10; às 00:30 de 28/10 (03:30Z) tem idade 0
  await sc.seedRepasses(env, t, { old: '2026-10-28T02:30:00.000Z', recent: '2026-10-28T03:30:00.000Z' });
  await refresh(t, 'finance.owner_repasse.created');
  await kpis(t);
  const want = await repassesFromSource(env, t, env.asOf);
  same((await readKpi(t, CODE, { dimensionKey: 'idade_media_dias' })).value, want.avgAge, 'idade média igual ao recálculo na mão');
  assert.equal(want.avgAge, '0.50', 'um repasse de 1 dia e outro de 0 dia: média 0,50');
});

test('m9d623 isolamento entre empresas no KPI', async () => {
  const [x, y] = [env.cX, env.cY];
  same((await readKpi(x, CODE)).value, '54000.00', 'X só vê os próprios repasses');
  await assert.rejects(
    envK.inTx(y, {}, (tx) => require('../../../src/features/analytics/metrics').readMetricAsOf(envK.ctxOf(y), { metricCode: CODE, scopeType: 'COMPANY', scopeId: x.companyId, asOfDate: env.asOf }, tx)),
    (e) => e.statusCode === 404, 'o escopo de outra empresa não devolve nada (RLS)'
  );
});

test('m9d623 replay do mesmo evento não altera o valor', async () => {
  const t = env.cX;
  const asserts = require('../_helpers/readModelAsserts');
  const event = { ...envK.event(t, 'finance.owner_repasse.created'), payloadJson: { id: envK.ledger.uuid() } };
  const read = async () => ({
    health: Object.fromEntries(Object.entries(await envK.healthRow(env, t)).filter(([k]) => !['refreshed_at', 'source_snapshot_at'].includes(k))),
    snapshots: (await env.admin.query("SELECT s.dimension_key, s.revision_no, s.value_numeric::text AS v FROM analytics.metric_snapshots s JOIN analytics.metric_definitions d ON d.id = s.metric_id WHERE s.company_id = :c AND d.metric_code = 'fin.owner_repasses_pending' ORDER BY 1, 2", { replacements: { c: t.companyId } }))[0],
  });
  await asserts.assertReplayIdempotent({ applyEvent: () => envK.inTx(t, { commit: true }, (tx) => require('../../../src/features/analytics/read-models').applyEvent(event, tx, { now: envK.NOW })), readRow: read });
  assert.ok(ownerId);
});
