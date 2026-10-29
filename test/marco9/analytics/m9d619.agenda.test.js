'use strict';

// M9-D619 — a agenda (job das 00:05 de São Paulo e a cada 15 minutos) recalcula o que depende do relógio, sem nenhum evento; e o parâmetro do
// administrador muda o resultado.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bi = require('../_helpers/biObrasJuridicoEnv');
const sc = require('../_helpers/m9d619Scenario');
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

test('m9d619 agenda recalcula o que depende do relógio', async () => {
  const result = await bi.runSchedule(env.tenantA, new Date('2026-11-05T15:00:00Z')); // 8 dias depois, sem nenhum evento
  assert.ok(result.some((r) => r.readModel === 'rm_legal_deadlines'), 'a agenda passou pelos prazos');
  const deadlines = (await bi.rowsOf(env, 'rm_legal_deadlines', env.tenantA)).find((r) => iso(r.as_of_date) === '2026-11-05');
  // em 05/11: hoje..hoje+6 = 05/11..11/11; hoje+7..hoje+29 = 12/11..04/12; vencidos = antes de 05/11
  assert.deepEqual(o.pick(deadlines, ['due_next_7d', 'due_7_to_29d', 'overdue', 'oldest_overdue_days', 'open_total']), { due_next_7d: 0, due_7_to_29d: 2, overdue: 6, oldest_overdue_days: 18, open_total: 8 },
    'os prazos de 28/10 a 04/11 venceram; 26/11 e 27/11 entraram na faixa de hoje+7 a hoje+29');
  const stage = o.byKey(await bi.rowsOf(env, 'rm_fin_cases_stage', env.tenantA), ['stage']);
  assert.equal(stage.get('UNDER_ANALYSIS').days_in_stage_sum, 26 + 2 * 8, 'cada caso em análise ganhou 8 dias no estágio');
  const [refresh] = (await env.admin.query("SELECT \"trigger\", status FROM analytics.read_model_refreshes WHERE read_model = 'rm_fin_cases_stage' AND company_id = :c ORDER BY started_at DESC LIMIT 1", { replacements: { c: env.tenantA.companyId } }))[0];
  assert.deepEqual([refresh.trigger, refresh.status], ['SCHEDULE', 'SUCCEEDED']);
});

test('m9d619 parâmetro do administrador: status que encerram o processo', async () => {
  await bi.setSetting(env, env.tenantA, 'analytics.juridico.processo_encerrado_status', 'CLOSED,ARCHIVED,CANCELLED,OPEN');
  await bi.apply(env.tenantA, bi.makeEvent(env.tenantA, 'legal.case.updated', { id: ids.cases.k1 }));
  assert.equal((await bi.rowsOf(env, 'rm_legal_cases_risk', env.tenantA)).length, 0, 'com OPEN na lista nenhum processo é ativo');
  const values = await bi.rowsOf(env, 'rm_legal_values', env.tenantA);
  assert.deepEqual(values.map((v) => [v.case_type, v.risk_level, v.estimated_total, v.confirmed_total]).sort(), [['EVICTION', 'HIGH', '0.00', '20000.00'], ['LABOR', 'LOW', '0.00', '7000.00']].sort(),
    'o confirmado continua; o estimado some junto com o processo ativo');
  await bi.setSetting(env, env.tenantA, 'analytics.juridico.processo_encerrado_status', 'CLOSED,ARCHIVED,CANCELLED');
  await bi.apply(env.tenantA, bi.makeEvent(env.tenantA, 'legal.case.updated', { id: ids.cases.k1 }));
  assert.equal((await bi.rowsOf(env, 'rm_legal_cases_risk', env.tenantA)).length, 2, 'voltando ao padrão os ativos voltam');
});
