'use strict';

// M9-D685 (bloco 4) — dinheiro parado e perdido: fórmula escrita, totais SEPARADOS, repasses de terceiros à parte (BI-005) e destacados (M9-D623), componentes pelo parâmetro do
// administrador e conclusão adiada quando um componente tem dado ruim (M9-D697). Banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const e685 = require('../_helpers/m9d685Env');
const { parseComponents, CENTRO_DEFAULTS, KEYS } = require('../../../src/features/analytics/centroSettings');
const { SETTINGS_SCHEMA } = require('../../../src/features/settings/settings.service');

const { openCenter, blockOf, setSetting, clearSetting } = e685;
const ok = (value, dims = []) => ({ value, status: 'OK', dimensions: dims.map(([key, v]) => ({ key, value: v })) });
let env;
const money = (res) => blockOf(res, 'DINHEIRO');
const itemOf = (res, type) => money(res).items.find((i) => i.type === type);

before(async () => { env = await e685.setup(); await e685.clearQueueAndAlerts(env, env.tenantA); await e685.seedScenario(env); });
after(async () => { await e685.clearQueueAndAlerts(env, env.tenantA); await e685.teardown(env); });

test('m9d685 dinheiro parado e perdido são totais separados e a fórmula bate com os componentes', async () => {
  const res = await openCenter(env);
  const parado = itemOf(res, 'DINHEIRO_PARADO');
  const perdido = itemOf(res, 'DINHEIRO_PERDIDO');
  assert.equal(parado.value, '79000.00', 'parado = recebíveis vencidos 16.000,00 + medições pendentes 40.000,00 + comissão a receber 23.000,00');
  assert.equal(parado.formatted, 'R$ 79.000,00');
  assert.deepEqual(parado.components.map((c) => [c.metricCode, c.amount]), [['fin.overdue_receivables', '16000.00'], ['obra.measurements', '40000.00'], ['cor.commission', '23000.00']]);
  assert.equal(perdido.value, '5000.00', 'perdido = perdas de estoque 1.500,00 + desperdício 800,00 + custo de pós-obra 2.700,00');
  assert.deepEqual(perdido.components.map((c) => c.metricCode), ['inv.losses', 'obra.waste', 'obra.postwork_cost']);
  assert.ok(parado.components.concat(perdido.components).every((c) => c.valueNatureLabel && c.label && c.formatted), 'cada componente com rótulo e natureza');
  assert.ok(parado.components.concat(perdido.components).every((c) => c.freshness && c.freshness.state), 'cada componente com o selo de atualização da métrica');
  const totals = money(res).totals;
  assert.deepEqual([totals.parado.formatted, totals.perdido.formatted, totals.parado.separate, totals.perdido.separate], ['R$ 79.000,00', 'R$ 5.000,00', true, true]);
  assert.equal(totals.total, undefined, 'nunca um total único');
  assert.ok(!res.body.data.blocks.flatMap((b) => b.items).some((i) => i.value === '84000.00'), 'parado + perdido nunca somados');
});

test('m9d685 repasses vencidos aparecem como terceiros e não entram no parado próprio', async () => {
  const res = await openCenter(env);
  const third = itemOf(res, 'DINHEIRO_TERCEIROS');
  assert.equal(third.value, '5000.00', 'repasses vencidos de 5.000,00 listados à parte');
  assert.deepEqual(third.components.map((c) => [c.metricCode, c.apart]), [['fin.owner_repasses_pending', true]]);
  assert.match(third.detail, /Nunca somado/);
  assert.equal(itemOf(res, 'DINHEIRO_PARADO').value, '79000.00', 'o parado não muda por causa dos repasses');
  assert.ok(!itemOf(res, 'DINHEIRO_PARADO').components.some((c) => c.metricCode === 'fin.owner_repasses_pending'));
  assert.equal(money(res).totals.terceiros.components[0].apart, true);
});

test('m9d685 repasse parado além do prazo de alerta é destacado, sem alerta próprio e sem tornar o indicador DEGRADED', async () => {
  const res = await openCenter(env);
  const third = itemOf(res, 'DINHEIRO_TERCEIROS');
  assert.deepEqual([third.highlight, third.components[0].highlight, third.components[0].overdueCount, third.severity], [true, true, 1, 'WARNING']);
  assert.equal(third.components[0].totalPendingFormatted, 'R$ 9.000,00', 'o total pendente aparece ao lado do vencido');
  assert.equal(money(res).deferred, false, 'o indicador continua confiável');
  await e685.seedScenario(env, { 'fin.owner_repasses_pending': ok('9000.00', [['vencidos_alerta_brl', '0.00'], ['vencidos_alerta_qtd', '0']]) });
  const calm = itemOf(await openCenter(env), 'DINHEIRO_TERCEIROS');
  assert.deepEqual([calm.highlight, calm.severity, calm.value], [false, 'INFO', '0.00'], 'sem repasse vencido além do prazo, sem destaque');
  const [alerts] = await env.admin.query('SELECT count(*)::int AS n FROM analytics.alert_instances WHERE company_id = :c', { replacements: { c: env.tenantA.companyId } });
  assert.equal(alerts[0].n, 0, 'o destaque não abre alerta');
  await e685.seedScenario(env);
});

test('m9d685 bloco com métrica DEGRADED mostra conclusão adiada', async () => {
  await e685.seedScenario(env, {}, { degraded: ['fin.overdue_receivables'] });
  const res = await openCenter(env);
  const block = money(res);
  assert.deepEqual([block.deferred, block.deferredText, block.items], [true, 'Conclusão adiada: dado incompleto', []]);
  assert.deepEqual(block.reasons.map((r) => [r.metricCode, r.problem]), [['fin.overdue_receivables', 'DEGRADED']]);
  const widget = res.body.data.widgets.find((w) => w.config && w.config.blockKey === 'DINHEIRO');
  assert.equal(widget.block.deferred, true, 'o mecanismo evaluateBlock da M9-D697 decide');
  assert.ok(res.body.data.widgets[0].banner.degradedMetrics.some((d) => d.metricCode === 'fin.overdue_receivables'), 'a faixa de qualidade lista o indicador ruim');
  assert.equal(blockOf(res, 'PRAZOS').deferred, false, 'os outros blocos seguem concluindo');
  for (const status of [{ degraded: [] , stale: ['obra.waste'] }]) { // dado desatualizado também adia
    await e685.seedScenario(env, {}, status);
    assert.equal(money(await openCenter(env)).deferred, true, 'STALE adia');
  }
  await e685.seedScenario(env, {}, { skip: ['inv.losses'] });
  assert.equal(money(await openCenter(env)).deferred, true, 'sem registro (INCOMPLETE) adia');
  await e685.seedScenario(env);
});

test('m9d685 componentes do dinheiro parado vêm do parâmetro do administrador, com validação', async () => {
  assert.deepEqual(parseComponents(CENTRO_DEFAULTS[KEYS.moneyComponents]).map((c) => [c.code, c.group, c.apart]), [
    ['fin.overdue_receivables', 'PARADO', false], ['obra.measurements', 'PARADO', false], ['cor.commission', 'PARADO', false], ['fin.owner_repasses_pending', 'PARADO', true],
    ['inv.losses', 'PERDIDO', false], ['obra.waste', 'PERDIDO', false], ['obra.postwork_cost', 'PERDIDO', false],
  ]);
  for (const bad of ['', 'PARADO: x.y; PERDIDO: inv.losses', 'PARADO: inv.losses; PERDIDO: obra.waste', 'PARADO: fin.overdue_receivables', 'PARADO: fin.overdue_receivables + fin.overdue_receivables; PERDIDO: inv.losses']) {
    assert.equal(parseComponents(bad), null, bad);
    assert.throws(() => SETTINGS_SCHEMA[KEYS.moneyComponents].validate(KEYS.moneyComponents, bad), (err) => err.code === 'SETTING_INVALID_VALUE');
  }
  await setSetting(env, env.tenantA, KEYS.moneyComponents, 'PARADO: fin.overdue_receivables; PERDIDO: inv.losses + obra.waste');
  const res = await openCenter(env);
  assert.deepEqual([itemOf(res, 'DINHEIRO_PARADO').value, itemOf(res, 'DINHEIRO_PERDIDO').value], ['16000.00', '2300.00'], 'o administrador tirou medições, comissão e pós-obra da fórmula');
  assert.equal(itemOf(res, 'DINHEIRO_TERCEIROS'), undefined, 'sem o repasse na fórmula, sem a linha de terceiros');
  await clearSetting(env, env.tenantA, KEYS.moneyComponents);
});
