'use strict';

// M9-D652 — KPI obra.recurrence: reprodução a partir das não conformidades e dos casos de garantia, regra de 2 ou mais ocorrências na janela (180 dias,
// parâmetro), ranking das 10 maiores, causa/equipe/material separados e sem classificação em details.unclassified, qualidade e fuso de São Paulo.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const e = require('../_helpers/m9d652Env');
const sc = require('../_helpers/m9d652Scenario');
const oracle = require('../_helpers/m9d652Oracle');
const money = require('../../../src/features/analytics/metrics/formulas/money');

const CODE = 'obra.recurrence';
let env;
const T = () => env.cX;
const U = () => env.cY;
before(async () => { env = await e.setup(); });
after(() => e.teardown(env));

const refresh = async (t, projects, cases = []) => {
  for (const p of projects) { await e.apply(t, 'project.created', { id: p }); await e.apply(t, 'nonconformity.opened', { projectId: p }); }
  for (const id of cases) await e.apply(t, 'warranty.case.opened', { id });
};
const dim = async (t, key) => String(Number((await e.readKpi(t, CODE, { dimensionKey: key })).value)); // numeric(20,4): "7.0000" é 7
const same = (a, b) => assert.equal(money.cmp(a, b), 0, `${a} x ${b}`);

test('m9d652 reproduz obra.recurrence a partir dos registros-fonte', async () => {
  const projects = await sc.seedInfiltration(env, T());
  const c1 = await sc.warrantyCase(env, T(), projects[0], { root_cause_code: 'infiltracao', created_at: sc.at('2026-09-01') });
  await sc.action(env, T(), c1, { assigned_team: 'Equipe B', material_used: 'Manta', cost: '800.00' });
  const c2 = await sc.warrantyCase(env, T(), projects[1], { root_cause_code: 'infiltracao', created_at: sc.at('2026-09-15') });
  await sc.action(env, T(), c2, { assigned_team: 'Equipe B', material_used: 'Manta', cost: '200.00', });
  await refresh(T(), projects, [c1, c2]);
  const out = await e.run(T(), 'obra');
  const want = await oracle.recurrence(env, T(), e.AS_OF);
  const got = out.kpis[CODE];
  assert.equal(got.status, 'OK');
  assert.equal(got.value, String(want.count));
  assert.deepEqual(got.details.ranking.map((r) => [`${r.kind}:${r.value}`, Number(r.occurrences), Number(r.projects), r.cost]), want.ranking.map((r) => [r.key, r.n, r.projects, r.cost]));
  assert.equal(want.ranking[0].key, 'causa:INFILTRACAO');
  assert.deepEqual([want.ranking[0].n, want.ranking[0].projects], [7, 5], 'infiltração: 7 ocorrências em 5 obras (5 não conformidades e 2 casos)');
  assert.equal(await dim(T(), 'causa:INFILTRACAO'), '7');
  assert.equal(await dim(T(), 'causa:INFILTRACAO:obras_qtd'), '5');
  same(await dim(T(), 'causa:INFILTRACAO:custo_brl'), '1000.00');
  assert.equal(await dim(T(), 'equipe:Equipe B'), '7');
  assert.equal(await dim(T(), 'material:Manta'), '2');
  const kpi = await e.readKpi(T(), CODE);
  assert.deepEqual([kpi.status, kpi.unit, kpi.version], ['OK', 'COUNT', 1]);
  same(kpi.value, String(want.count));
});

test('m9d652 obra.recurrence fica DEGRADED com valor nulo quando a regra de qualidade falha', async () => {
  const p = await sc.project(env, U(), 'Obra D');
  for (const day of ['2026-10-01', '2026-10-02', '2026-10-03']) await sc.nonconformity(env, U(), p, sc.at(day), { cause_code: 'solo' });
  await refresh(U(), [p]);
  const ok = await e.run(U(), 'obra');
  assert.equal(ok.kpis[CODE].status, 'OK', 'no padrão (100%) a falta de classificação só é contada');
  assert.deepEqual(ok.kpis[CODE].details.unclassified, { causa: '0', equipe: '3', material: '3' });
  await e.setSetting(env, U(), 'analytics.obra.recorrencia_max_sem_classificacao_pct', 50);
  const out = await e.run(U(), 'obra');
  assert.deepEqual([out.kpis[CODE].status, out.kpis[CODE].value, out.kpis[CODE].details.reason], ['DEGRADED', null, 'OCORRENCIA_SEM_CLASSIFICACAO_ACIMA_DO_LIMITE']);
  const kpi = await e.readKpi(U(), CODE);
  assert.deepEqual([kpi.status, kpi.value], ['DEGRADED', null]);
});

test('m9d652 recurrence conta 2 ou mais ocorrências da mesma combinação em 180 dias', async () => {
  const [a, b] = [await sc.project(env, T(), 'Obra E'), await sc.project(env, T(), 'Obra F')];
  await sc.nonconformity(env, T(), a, sc.at('2026-10-10'), { cause_code: 'unica', team_label: 'Equipe U' }); // 1 ocorrência: não é recorrência
  await sc.nonconformity(env, T(), a, sc.at('2026-04-30', 15), { cause_code: 'longe', team_label: 'Equipe L' }); // 181 dias antes da data-base
  await sc.nonconformity(env, T(), b, sc.at('2026-10-28'), { cause_code: 'longe', team_label: 'Equipe L' });
  await sc.nonconformity(env, T(), a, sc.at('2026-05-01', 15), { cause_code: 'limite', team_label: 'Equipe M' }); // 180 dias antes: ainda conta
  await sc.nonconformity(env, T(), b, sc.at('2026-10-28'), { cause_code: 'limite', team_label: 'Equipe M' });
  await refresh(T(), [a, b]);
  await e.run(T(), 'obra');
  const want = await oracle.recurrence(env, T(), e.AS_OF);
  const keys = want.ranking.map((r) => r.key);
  assert.ok(keys.includes('causa:LIMITE') && keys.includes('equipe:Equipe M'), '2 em exatamente 180 dias é recorrência');
  assert.ok(!keys.includes('causa:LONGE') && !keys.includes('equipe:Equipe L'), '2 em 181 dias não é');
  assert.ok(!keys.includes('causa:UNICA'), '1 ocorrência não é recorrência');
  assert.equal(await dim(T(), 'causa:LIMITE'), '2');
});

test('m9d652 recurrence ranqueia as 10 maiores combinações com contagem, obras afetadas e custo', async () => {
  const p = await sc.project(env, U(), 'Obra G');
  const q = await sc.project(env, U(), 'Obra H');
  for (let i = 1; i <= 11; i += 1) {
    const cause = `top${String(i).padStart(2, '0')}`;
    await sc.nonconformity(env, U(), p, sc.at('2026-10-10'), { cause_code: cause });
    await sc.nonconformity(env, U(), q, sc.at('2026-10-11'), { cause_code: cause });
  }
  for (let i = 0; i < 2; i += 1) await sc.nonconformity(env, U(), p, sc.at('2026-10-12'), { cause_code: 'top11' }); // top11 tem 4 ocorrências: vai à frente de todas
  await e.setSetting(env, U(), 'analytics.obra.recorrencia_max_sem_classificacao_pct', 100);
  await refresh(U(), [p, q]);
  const out = await e.run(U(), 'obra');
  const want = await oracle.recurrence(env, U(), e.AS_OF);
  const causes = out.kpis[CODE].details.ranking.filter((r) => r.kind === 'causa');
  assert.equal(out.kpis[CODE].details.ranking.length, 10, 'o ranking tem as 10 maiores');
  assert.deepEqual(out.kpis[CODE].details.ranking.map((r) => `${r.kind}:${r.value}`), want.ranking.map((r) => r.key));
  assert.equal(causes[0].value, 'TOP11', 'maior contagem primeiro');
  const tied = causes.filter((r) => r.occurrences === '2').map((r) => r.value);
  assert.deepEqual(tied, [...tied].sort(), 'empate de contagem e custo: pela chave');
  assert.equal(Number(out.kpis[CODE].value), want.count, 'o valor conta todas as combinações recorrentes, não só as 10');
});

test('m9d652 recurrence separa causa, equipe e material e manda a ocorrência sem classificação para details.unclassified', async () => {
  const t = env.cY;
  const p = await sc.project(env, t, 'Obra I');
  const unclassified = await sc.nonconformity(env, t, p, sc.at('2026-10-20'), {});
  await e.setSetting(env, t, 'analytics.obra.recorrencia_max_sem_classificacao_pct', 100);
  await refresh(t, [p]);
  const out = await e.run(t, 'obra');
  const want = await oracle.recurrence(env, t, e.AS_OF);
  assert.ok(unclassified);
  assert.deepEqual(out.kpis[CODE].details.unclassified, Object.fromEntries(Object.entries(want.unclassified).map(([k, v]) => [k, String(v)])));
  assert.ok(Number(out.kpis[CODE].details.unclassified.causa) >= 1, 'a não conformidade sem causa fica fora do ranking e é contada');
  assert.ok(out.kpis[CODE].details.ranking.every((r) => !['NAO_INFORMADA', ''].includes(r.value)));
  const kinds = new Set(out.kpis[CODE].details.ranking.map((r) => r.kind));
  assert.ok(kinds.has('causa'), 'causa aparece separada de equipe e material');
});

test('m9d652 recurrence respeita o parâmetro analytics.obra.recorrencia_dias', async () => {
  const t = env.cX;
  const [a, b] = [await sc.project(env, t, 'Obra J'), await sc.project(env, t, 'Obra K')];
  await sc.nonconformity(env, t, a, sc.at('2026-07-20'), { cause_code: 'janela', team_label: 'Equipe J' }); // 100 dias antes
  await sc.nonconformity(env, t, b, sc.at('2026-10-27'), { cause_code: 'janela', team_label: 'Equipe J' });
  await refresh(t, [a, b]);
  assert.equal((await oracle.recurrence(env, t, e.AS_OF)).ranking.some((r) => r.key === 'causa:JANELA'), true);
  const before = await e.run(t, 'obra');
  assert.ok(before.kpis[CODE].details.ranking.some((r) => r.value === 'JANELA'), 'com 180 dias a combinação é recorrente');
  await e.setSetting(env, t, 'analytics.obra.recorrencia_dias', 90);
  const after90 = await e.run(t, 'obra');
  assert.equal((await oracle.recurrence(env, t, e.AS_OF, { days: 90 })).ranking.some((r) => r.key === 'causa:JANELA'), false);
  assert.ok(!after90.kpis[CODE].details.ranking.some((r) => r.value === 'JANELA'), 'com 90 dias deixa de ser');
  assert.equal(after90.kpis[CODE].details.windowDays, '90');
  await e.setSetting(env, t, 'analytics.obra.recorrencia_dias', 180);
});

test('m9d652 timezone: ocorrência às 23:30 de São Paulo cai no dia certo', async () => {
  const t = env.cY;
  const [a, b] = [await sc.project(env, t, 'Obra L'), await sc.project(env, t, 'Obra M')];
  // 2026-05-01T02:30Z é 30/04 às 23:30 em São Paulo: 181 dias antes de 28/10, fora da janela (em UTC pareceria dia 01/05, dentro)
  await sc.nonconformity(env, t, a, '2026-05-01T02:30:00Z', { cause_code: 'fuso', team_label: 'Equipe F' });
  await sc.nonconformity(env, t, b, sc.at('2026-10-28'), { cause_code: 'fuso', team_label: 'Equipe F' });
  // 2026-10-29T02:30Z é 28/10 às 23:30 em São Paulo: ainda é o dia-base
  await sc.nonconformity(env, t, a, '2026-10-29T02:30:00Z', { cause_code: 'noite', team_label: 'Equipe N' });
  await sc.nonconformity(env, t, b, sc.at('2026-10-27'), { cause_code: 'noite', team_label: 'Equipe N' });
  await refresh(t, [a, b]);
  const out = await e.run(t, 'obra');
  const keys = out.kpis[CODE].details.ranking.map((r) => `${r.kind}:${r.value}`);
  assert.ok(!keys.includes('causa:FUSO'), 'a ocorrência de 30/04 (SP) está a 181 dias');
  assert.ok(keys.includes('causa:NOITE'), 'a ocorrência de 28/10 às 23:30 (SP) entra no dia-base');
  assert.ok(keys.every((k) => !k.endsWith('FUSO')));
});
