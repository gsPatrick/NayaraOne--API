'use strict';

// M9-D651 — regra de qualidade dos três KPIs: etapa sem data prevista (INCOMPLETE), medição aprovada sem lançamento de pagamento previsto (DEGRADED) e
// não conformidade sem causa acima do limite configurável (DEGRADED); em todos o valor é nulo (nunca um número enganoso).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bi = require('../_helpers/obraKpiEnv');
const scenario = require('../_helpers/m9d651Scenario');
const money = require('../../../src/features/analytics/metrics/formulas/money');
require('../../../src/features/analytics');

let env;
let ids;
before(async () => {
  env = await bi.setup();
  ids = await scenario.seedAll(env, env.tenantA);
});
after(() => bi.teardown(env));

const read = (code, key = '') => bi.readKpi(env.tenantA, code, { dimensionKey: key });
const same = (a, b, msg) => assert.equal(money.cmp(a, b), 0, `${msg}: ${a} x ${b}`);

test('m9d651 obra.delays fica INCOMPLETE com valor nulo quando a regra de qualidade falha (etapa sem data prevista)', async () => {
  await scenario.stage(env, env.tenantA, ids.delta, 8, { status: 'PENDING' }); // sem fim previsto
  await bi.refresh(env.tenantA, [{ id: ids.delta }]);
  const out = await bi.kpis(env.tenantA);
  assert.deepEqual([out.kpis['obra.delays'].status, out.kpis['obra.delays'].details.reason, out.kpis['obra.delays'].details.stagesWithoutDate], ['INCOMPLETE', 'ETAPA_SEM_DATA_PREVISTA', '1']);
  const kpi = await read('obra.delays');
  assert.deepEqual([kpi.status, kpi.value], ['INCOMPLETE', null], 'a tela mostra "Dado incompleto": status sem valor');
  assert.ok(kpi.revisionNo >= 2, 'a revisão anterior (OK) continua gravada');
});

test('m9d651 obra.measurements fica DEGRADED com valor nulo quando a regra de qualidade falha (medição aprovada sem lançamento de pagamento)', async () => {
  await bi.seed(env, env.tenantA, 'construction.stage_measurements', {
    project_stage_id: ids.e1, measured_pct: '10', measured_at: '2026-10-01', status: 'APPROVED', total_amount: '20000.00', submitted_at: '2026-10-02T15:00:00Z',
  });
  await bi.refresh(env.tenantA, [{ id: ids.delta, stage: ids.e1 }]);
  const out = await bi.kpis(env.tenantA);
  assert.deepEqual([out.kpis['obra.measurements'].status, out.kpis['obra.measurements'].details.reason, out.kpis['obra.measurements'].details.approvedWithoutPayment], ['DEGRADED', 'MEDICAO_APROVADA_SEM_LANCAMENTO', '1']);
  const kpi = await read('obra.measurements');
  assert.deepEqual([kpi.status, kpi.value], ['DEGRADED', null]);
});

test('m9d651 obra.nonconformities fica DEGRADED com valor nulo quando a causa não informada passa do limite, e o limite é parâmetro do administrador', async () => {
  const sem = { project_id: ids.delta, description: 'Sem causa', status: 'OPEN', created_at: '2026-10-20T15:00:00Z' };
  await bi.seed(env, env.tenantA, 'construction.nonconformities', sem);
  await bi.seed(env, env.tenantA, 'construction.nonconformities', sem);
  await bi.refresh(env.tenantA, [{ id: ids.delta }]);
  const rows = await bi.rowsOf(env, 'rm_project_nonconformities', env.tenantA);
  assert.deepEqual(rows.filter((r) => r.cause === 'NAO_INFORMADA').map((r) => [r.team_id, r.open]), [['NAO_INFORMADA', 2]], 'sem causa vira NAO_INFORMADA');
  const out = await bi.kpis(env.tenantA);
  assert.deepEqual([out.kpis['obra.nonconformities'].status, out.kpis['obra.nonconformities'].details.reason, out.kpis['obra.nonconformities'].details.withoutCausePct], ['DEGRADED', 'CAUSA_NAO_INFORMADA_ACIMA_DO_LIMITE', '10.00']);
  const kpi = await read('obra.nonconformities');
  assert.deepEqual([kpi.status, kpi.value], ['DEGRADED', null]);
  await bi.setSetting(env, env.tenantA, 'analytics.qualidade.max_sem_causa_pct', 20);
  const again = await bi.kpis(env.tenantA);
  assert.equal(again.kpis['obra.nonconformities'].status, 'OK', '10% passa de um limite de 20%');
  same((await read('obra.nonconformities')).value, '9', '7 + 2 abertas');
  same((await read('obra.nonconformities', 'causa:NAO_INFORMADA')).value, '2', 'a causa não informada aparece como dimensão');
});

test('m9d651 sem nenhuma obra nada é inventado: a outra empresa não ganha snapshot', async () => {
  const out = await bi.kpis(env.tenantB);
  assert.deepEqual([out.written, Object.keys(out.kpis)], [0, []]);
});
