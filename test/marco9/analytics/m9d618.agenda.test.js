'use strict';

// M9-D618 — a agenda (job das 00:05 de São Paulo e a cada 15 minutos) recalcula o que depende do relógio, sem nenhum evento; e os parâmetros do
// administrador mudam o resultado.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bi = require('../_helpers/biObrasJuridicoEnv');
const sc = require('../_helpers/m9d618Scenario');
const o = require('../_helpers/m9d618Oracle');

let env;
let ids;
before(async () => {
  env = await bi.setup(sc.MODELS);
  ids = await sc.seedAll(env, env.tenantA);
  await sc.applyAll(env.tenantA, ids);
});
after(() => bi.teardown(env));

const iso = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : d);
const find = async (model, tenant, project) => (await bi.rowsOf(env, model, tenant)).find((r) => r.project_id === project);

test('m9d618 agenda recalcula o que depende do relógio', async () => {
  const day = (asOf) => bi.runSchedule(env.tenantA, new Date(`${asOf}T15:00:00Z`));
  const result = await day('2026-11-10'); // 13 dias depois, sem nenhum evento
  assert.ok(result.length >= 5, 'a passada recalcula os read models que dependem do relógio');
  const delays = await find('rm_project_delays', env.tenantA, ids.p1);
  assert.deepEqual(o.pick(delays, ['delayed_stages', 'max_delay_days', 'delay_days_sum']), { delayed_stages: 1, max_delay_days: 21, delay_days_sum: 21 }, 'a etapa que vencia em 20/10 está 21 dias atrasada em 10/11');
  const progress = await find('rm_project_progress', env.tenantA, ids.p1);
  assert.equal(iso(progress.forecast_finish_date), o.paceFinish('2026-09-18', '2026-11-10', progress.actual_percent), 'a previsão anda com os dias decorridos');
  const nc = o.byKey(await bi.rowsOf(env, 'rm_project_nonconformities', env.tenantA), ['cause', 'team_id']);
  assert.equal(nc.has('PROJETO|Equipe B'), false, 'a fechada em 29/09 saiu da janela de 30 dias');
  assert.equal(nc.get('MATERIAL|Equipe A').closed_30d, 1);
  const inv = (await bi.rowsOf(env, 'rm_inventory_health', env.tenantA)).find((r) => iso(r.as_of_date) === '2026-11-10');
  assert.equal(inv.losses_30d, '120.00', 'em 10/11 a janela começa em 12/10: sobra só a perda de 20/10');
  const tools = (await bi.rowsOf(env, 'rm_tool_assets', env.tenantA)).find((r) => iso(r.as_of_date) === '2026-11-10');
  assert.equal(tools.loans_overdue, 3, 'o empréstimo que vencia em 28/10 passou a estar em atraso');
  const [refresh] = (await env.admin.query("SELECT \"trigger\", status FROM analytics.read_model_refreshes WHERE read_model = 'rm_project_delays' AND company_id = :c ORDER BY started_at DESC LIMIT 1", { replacements: { c: env.tenantA.companyId } }))[0];
  assert.deepEqual([refresh.trigger, refresh.status], ['SCHEDULE', 'SUCCEEDED']);
});

test('m9d618 parâmetros do administrador: método de previsão, status da receita e tipos de item', async () => {
  await bi.setSetting(env, env.tenantA, 'analytics.obra.previsao_metodo', 'PLANEJADO');
  await bi.setSetting(env, env.tenantA, 'analytics.obra.receita_contrato_status', 'ACTIVE');
  await bi.setSetting(env, env.tenantA, 'analytics.estoque.tipos_item', 'CONSUMABLE,TOOL');
  await sc.applyAll(env.tenantA, ids); // eventos novos (mesmo tipo e payload) são eventos distintos: recalculam o estado
  const progress = await find('rm_project_progress', env.tenantA, ids.p1);
  assert.equal(iso(progress.forecast_finish_date), '2026-12-28', 'PLANEJADO: o término previsto é o planejado');
  const cost = await find('rm_project_cost', env.tenantA, ids.p1);
  assert.deepEqual([cost.forecast_cost, cost.contract_revenue], ['900000.00', '1200000.00'], 'PLANEJADO repete o orçamento; só o contrato ACTIVE entra na receita');
  const inv = (await bi.rowsOf(env, 'rm_inventory_health', env.tenantA)).find((r) => iso(r.as_of_date) === '2026-10-28');
  assert.deepEqual([inv.stock_value, inv.items_below_min], ['1062.50', 3], 'a furadeira (TOOL, 1 × 300,00, mínimo 5) entra no estoque');
});
