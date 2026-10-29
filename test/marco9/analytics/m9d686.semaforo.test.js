'use strict';

// M9-D686 — Saúde Geral pela rota real: uma linha por área, a PIOR condição define a cor (alerta aberto, qualidade do dado, regra de semáforo do KPI), área sem dado
// nunca é verde, qualidade ruim impede verde e cor sempre vem com texto. Os snapshots vêm dos casos de teste das fórmulas, com a base verde de cada regra. Banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const e686 = require('../_helpers/m9d686Env');
const { AREAS } = require('../../../src/features/analytics/dashboards/health/health.areas');

const { ok, seedHealth, openHealth, areaOf, alertOf, clearHealth } = e686;
let env;
const colorOf = async (key, opts) => areaOf(await openHealth(env, opts), key);

before(async () => { env = await e686.setup(); await clearHealth(env); await seedHealth(env); });
after(async () => { await clearHealth(env); await e686.teardown(env); });

test('m9d686 uma linha por área, com cor, três KPIs, alertas abertos e selo de freshness do pior KPI, e a linha leva ao painel da área', async () => {
  const res = await openHealth(env);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.data.areas.map((a) => a.key), AREAS.map((a) => a.key), 'as áreas do parâmetro, na ordem');
  for (const area of res.body.data.areas) {
    assert.equal(area.kpis.length, 3, `${area.key}: os 3 KPIs principais`);
    assert.ok(area.href.startsWith('/painel/analytics/'), `${area.key}: a linha abre o painel da área`);
    assert.equal(typeof area.openAlerts, 'number');
    assert.ok(area.freshness && area.freshness.state && area.freshness.metricCode, `${area.key}: selo de freshness do pior KPI`);
    assert.ok(area.kpis.every((k) => k.metric && k.metric.freshness && k.metric.freshness.state), `${area.key}: cada KPI com freshness`);
  }
  assert.equal(res.body.data.widgets[0].type, 'QUALITY_BANNER', 'a faixa de qualidade é o primeiro widget');
  assert.deepEqual(res.body.data.areas.map((a) => a.light.color), AREAS.map(() => 'VERDE'), 'base: tudo confiável e dentro dos limites');
  assert.deepEqual(res.body.data.summary, { areas: 9, verde: 9, amarelo: 0, vermelho: 0, cinza: 0 });
});

test('m9d686 pior condição define a cor da área', async () => {
  await alertOf(env, env.tenantA, { metricCode: 'legal.deadlines', severity: 'CRITICAL', status: 'OPEN' });
  const legal = await colorOf('LEGAL');
  assert.deepEqual([legal.light.color, legal.openAlerts, legal.reasons], ['VERMELHO', 1, ['1 alerta crítico aberto']], 'Jurídico com 1 alerta CRITICAL: vermelho');
  await alertOf(env, env.tenantA, { metricCode: 'fin.free_cash', severity: 'WARNING', status: 'OPEN' });
  assert.equal((await colorOf('FINANCE')).light.color, 'AMARELO', 'alerta WARNING aberto: amarelo');
  await alertOf(env, env.tenantA, { metricCode: 'rent.vacancy', severity: 'INFO', status: 'OPEN' });
  assert.equal((await colorOf('RENTAL')).light.color, 'VERDE', 'alerta INFO aberto continua verde');
  await alertOf(env, env.tenantA, { metricCode: 'fin.free_cash', severity: 'CRITICAL', status: 'ACKNOWLEDGED' });
  await alertOf(env, env.tenantA, { metricCode: 'tec.availability', severity: 'CRITICAL', status: 'RESOLVED' });
  assert.equal((await colorOf('TECH')).light.color, 'VERDE', 'alerta resolvido não pesa');
  await clearHealth(env);
  // regras de semáforo por KPI (padrões do livro)
  const cases = [
    ['FINANCE', 'fin.breathing_need', ok('1500.00'), 'AMARELO'], // necessidade para respirar > 0 = amarelo
    ['LEGAL', 'legal.deadlines', ok('4', [['proximos_7d_qtd', '1'], ['ate_30d_qtd', '0'], ['vencidos_qtd', '3'], ['mais_antigo_vencido_dias', '4']]), 'VERMELHO'], // prazo vencido = vermelho
    ['RENTAL', 'rent.vacancy', ok('12.00'), 'AMARELO'], ['RENTAL', 'rent.vacancy', ok('21.00'), 'VERMELHO'],
    ['COMMERCIAL', 'crm.portfolio_without_next_action', ok('20', [['em_aberto_qtd', '100'], ['sem_acao_pct', '20.00']]), 'AMARELO'],
    ['COMMERCIAL', 'crm.portfolio_without_next_action', ok('40', [['em_aberto_qtd', '100'], ['sem_acao_pct', '40.00']]), 'VERMELHO'],
    ['CONSTRUCTION', 'obra.progress_vs_schedule', ok('50.00', [['planejado_pct', '57.00'], ['desvio_pp', '-7.00']]), 'AMARELO'],
    ['CONSTRUCTION', 'obra.progress_vs_schedule', ok('40.00', [['planejado_pct', '60.00'], ['desvio_pp', '-20.00']]), 'VERMELHO'],
    ['MARKETING', 'mkt.deliverability', ok('93.00'), 'AMARELO'], ['MARKETING', 'mkt.deliverability', ok('85.00'), 'VERMELHO'],
    ['SUPPORT', 'sup.sla_resolution', ok('85.00'), 'AMARELO'], ['SUPPORT', 'sup.sla_resolution', ok('70.00'), 'VERMELHO'],
    ['TECH', 'tec.availability', ok('99.50'), 'AMARELO'], ['TECH', 'tec.availability', ok('98.00'), 'VERMELHO'],
    ['CORRESPONDENT', 'cor.approval_rate_by_provider', ok('10', [['aprovadas_qtd', '5'], ['rejeitadas_qtd', '5'], ['taxa_pct', '50.00']]), 'AMARELO'],
    ['CORRESPONDENT', 'cor.approval_rate_by_provider', ok('10', [['aprovadas_qtd', '3'], ['rejeitadas_qtd', '7'], ['taxa_pct', '30.00']]), 'VERMELHO'],
  ];
  for (const [area, code, result, color] of cases) {
    await seedHealth(env, { [code]: result });
    const row = await colorOf(area);
    assert.equal(row.light.color, color, `${area} ${code}: ${color}`);
    assert.ok(row.reasons.length > 0, `${area}: o motivo da cor aparece`);
    assert.deepEqual(row.kpis.filter((k) => k.metricCode === code).map((k) => k.light.color), [color], `${code}: a cor do próprio KPI`);
  }
  await seedHealth(env, { 'fin.breathing_need': ok('1500.00'), 'legal.deadlines': ok('1', [['vencidos_qtd', '0']]) });
  await alertOf(env, env.tenantA, { metricCode: 'fin.free_cash', severity: 'CRITICAL', status: 'OPEN' });
  const finance = await colorOf('FINANCE');
  assert.equal(finance.light.color, 'VERMELHO', 'alerta crítico (vermelho) e regra do KPI (amarelo): a pior vence');
  await clearHealth(env);
  await seedHealth(env);
});

test('m9d686 área sem dado fica cinza e nunca verde', async () => {
  const marketing = AREAS.find((a) => a.key === 'MARKETING');
  await seedHealth(env, {}, { skip: ['mkt.deliverability', 'mkt.opt_out', 'mkt.campaigns'] });
  let row = await colorOf('MARKETING');
  assert.deepEqual([row.light.color, row.summary, row.noData, row.light.text], ['CINZA', 'Sem dados suficientes', true, 'Sem dados suficientes'], 'Marketing sem campanhas: cinza, nunca verde');
  assert.notEqual(row.light.color, 'VERDE');
  await seedHealth(env, {}, { degraded: marketing.kpis.concat([]) });
  row = await colorOf('MARKETING');
  assert.notEqual(row.light.color, 'CINZA', 'DEGRADED tem dado (só não confiável): a área não fica cinza');
  assert.equal(row.light.color, 'AMARELO');
  await seedHealth(env, {}, { skip: ['mkt.opt_out'] }); // só um indicador sem registro: não é "sem dado" da área e a falta impede o verde
  row = await colorOf('MARKETING');
  assert.deepEqual([row.light.color, row.noData], ['AMARELO', undefined], 'indicador sem registro: amarelo, nunca verde');
  await seedHealth(env);
});

test('m9d686 qualidade ruim impede verde', async () => {
  await seedHealth(env, {}, { degraded: ['fin.free_cash'] });
  let finance = await colorOf('FINANCE');
  assert.deepEqual([finance.light.color, finance.reasons.some((r) => /dado incompleto/.test(r))], ['AMARELO', true], 'free_cash DEGRADED: amarelo');
  assert.ok(finance.kpis.find((k) => k.metricCode === 'fin.free_cash').metric.incomplete, 'o KPI mostra "Dado incompleto" e nenhum número');
  await seedHealth(env, {}, { stale: ['fin.free_cash'] });
  finance = await colorOf('FINANCE');
  assert.equal(finance.light.color, 'AMARELO', 'STALE impede o verde');
  await seedHealth(env, {}, { never: ['fin.free_cash'] });
  assert.notEqual((await colorOf('FINANCE')).light.color, 'VERDE', 'indicador sem instante de atualização não é verde');
  await seedHealth(env);
  const old = await openHealth(env, { query: 'asOf=2026-10-20' });
  assert.ok(old.body.data.areas.every((a) => a.light.color !== 'VERDE'), 'sem registro na data-base nenhuma área é verde');
});

test('m9d686 cor sempre acompanhada de texto', async () => {
  await alertOf(env, env.tenantA, { metricCode: 'legal.deadlines', severity: 'CRITICAL', status: 'OPEN' });
  const res = await openHealth(env, { perms: ['analytics:read', 'legal:read'] });
  const colors = new Set();
  for (const area of res.body.data.areas) {
    assert.ok(area.light.text && area.summary, `${area.key}: texto da cor`);
    assert.match(area.light.text, /^(Verde: |Amarelo: |Vermelho: |Cinza: |Sem acesso$|Sem dados suficientes$)/, area.light.text);
    colors.add(area.light.color);
    for (const k of area.kpis) if (k.light) assert.match(k.light.text, /^(Verde|Amarelo|Vermelho): /, `${k.metricCode}: a cor do KPI com texto`);
  }
  assert.ok(colors.has('VERMELHO') && colors.has('CINZA'), 'vermelho (jurídico) e cinza (sem acesso) aparecem, ambos escritos');
  await clearHealth(env);
});
