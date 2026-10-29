'use strict';

// M9-D630 — crm.leads_by_origin: o número do KPI refeito do zero só com as oportunidades da fonte (centavo a centavo), a regra de qualidade (origem
// vazia), o fuso de São Paulo e o parâmetro do administrador. Banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const kit = require('../_helpers/crmKpiEnv');
const { leadsFromSource } = require('../_helpers/crmOracle630');

const { src, at, TODAY } = kit;
let env;
before(async () => { env = await kit.setup(); });
after(() => kit.teardown(env));

test('m9d630 reproduz crm.leads_by_origin a partir dos registros-fonte', async () => {
  const t = env.cX;
  const [b1, b2] = [src.uuid(), src.uuid()];
  const ids = [];
  const add = async (source, owner, created) => ids.push(await src.opportunity(env, t, { owner, source, created }));
  for (let i = 0; i < 4; i += 1) await add('PORTAL', b1, at(5 + i));
  for (let i = 0; i < 3; i += 1) await add('site', b2, at(10 + i)); // minúscula: é a mesma origem do SITE
  await add('SITE', b2, at(14));
  for (let i = 0; i < 2; i += 1) await add('INDICACAO', b1, at(15 + i));
  await add('PORTAL', b1, '2026-09-30T20:00:00Z'); // setembro: fora do período
  const deleted = await src.opportunity(env, t, { owner: b1, source: 'PORTAL', created: at(20) });
  await src.update(env, 'crm.opportunities', deleted, { deleted_at: at(21) }); // excluída: nunca é lead
  await kit.refreshAll(t, ids);
  await kit.kpis(t);

  const want = await leadsFromSource(env, t, TODAY);
  assert.equal(want.total, '10');
  assert.deepEqual(want.byOrigin, { PORTAL: 4, SITE: 4, INDICACAO: 2 });
  const kpi = await kit.readKpi(t, 'crm.leads_by_origin');
  assert.deepEqual([kpi.status, kpi.unit, kpi.version, kpi.metricCode], ['OK', 'COUNT', 1, 'crm.leads_by_origin']);
  assert.equal(Number(kpi.value), Number(want.total), 'total igual ao da fonte');
  let sum = 0;
  for (const [origin, count] of Object.entries(want.byOrigin)) {
    assert.equal(Number(await kit.dimension(t, 'crm.leads_by_origin', `origem:${origin}`)), count, `contagem de ${origin}`);
    assert.equal(Number(await kit.dimension(t, 'crm.leads_by_origin', `origem:${origin}:parte_pct`)), Number(want.percent[origin]), `percentual de ${origin}`);
    sum += count;
  }
  assert.equal(sum, Number(kpi.value), 'o total exibido é a soma das origens');
  assert.equal(Number(await kit.dimension(t, 'crm.leads_by_origin', `corretor:${b1}`)), 6);
  assert.equal(kpi.sourceRefs[0].table, 'crm.opportunities');
  assert.equal(kpi.sourceRefs[0].count, Number(want.total), 'o sourceRefs conta as mesmas oportunidades do valor');
  assert.ok(kpi.sourceSnapshotAt && kpi.refreshedAt && kpi.freshness);
  await kit.inTx(t, {}, async (tx) => {
    const { sourceRefs: [ref] } = await kit.registry.buildSourceRefs(kit.ctxOf(t), 'crm.leads_by_origin', { filter: kpi.sourceRefs[0].filter, unit: 'COUNT' }, tx);
    const r = await kit.registry.reconcileDetail(kit.ctxOf(t), 'crm.leads_by_origin', ref, kpi.value, { unit: 'COUNT' }, tx);
    assert.equal(r.ok, true, `detalhe ${r.detail} x KPI ${r.kpi}`);
  });
});

test('m9d630 timezone: lançamento às 23:30 de São Paulo cai no dia certo', async () => {
  const t = env.cY;
  const late = await src.opportunity(env, t, { owner: src.uuid(), source: 'SITE', created: '2026-10-29T02:30:00Z' }); // 23:30 de 28/10 em SP, já 29/10 em UTC
  const earlyMonth = await src.opportunity(env, t, { owner: src.uuid(), source: 'SITE', created: '2026-10-01T02:30:00Z' }); // 23:30 de 30/09 em SP, já outubro em UTC
  await kit.refreshAll(t, [late, earlyMonth]);
  const out = (await kit.kpis(t, '2026-10-28')).kpis['crm.leads_by_origin'];
  assert.equal(out.value, '1', 'só a de 23:30 do dia 28 conta em outubro; a de 23:30 de 30/09 é de setembro');
  const want = await leadsFromSource(env, t, '2026-10-28');
  assert.equal(want.total, '1');
  const [[row]] = await env.admin.query("SELECT day::text AS day FROM analytics.rm_crm_lead_daily WHERE company_id = :c AND day = '2026-10-28'", { replacements: { c: t.companyId } });
  assert.equal(row.day, '2026-10-28', 'o read model guardou o dia de São Paulo');
});

test('m9d630 crm.leads_by_origin fica DEGRADED com valor nulo quando a regra de qualidade falha', async () => {
  const t = env.cY;
  const ids = [];
  for (let i = 0; i < 7; i += 1) ids.push(await src.opportunity(env, t, { owner: src.uuid(), source: 'PORTAL', created: at(5 + i) }));
  ids.push(await src.opportunity(env, t, { owner: src.uuid(), source: null, created: at(12) }), await src.opportunity(env, t, { owner: src.uuid(), source: '', created: at(13) }));
  await kit.refreshAll(t, ids); // 2 de 10 sem origem (a de 23:30 do teste anterior também é lead de outubro): acima dos 5% padrão
  await kit.kpis(t);
  const kpi = await kit.readKpi(t, 'crm.leads_by_origin');
  assert.equal(kpi.status, 'DEGRADED');
  assert.equal(kpi.value, null, 'nunca um número enganoso');
  assert.equal(Number(await kit.dimension(t, 'crm.leads_by_origin', 'origem:NAO_INFORMADA')), 2, 'a origem vazia aparece como NAO_INFORMADA');
});

test('m9d630 o limite de origem vazia é parâmetro do administrador (analytics.qualidade.max_origem_vazia_pct)', async () => {
  const t = env.cY;
  await kit.setSetting(env, t, 'analytics.qualidade.max_origem_vazia_pct', 30);
  await kit.kpis(t);
  const kpi = await kit.readKpi(t, 'crm.leads_by_origin');
  assert.equal(kpi.status, 'OK', '2 de 10 sem origem (20%) passa com limite de 30%');
  assert.equal(Number(kpi.value), 10);
  await kit.setSetting(env, t, 'analytics.qualidade.max_origem_vazia_pct', 10);
  await kit.kpis(t);
  assert.equal((await kit.readKpi(t, 'crm.leads_by_origin')).status, 'DEGRADED', 'baixando o limite para 10% volta a DEGRADED');
});
