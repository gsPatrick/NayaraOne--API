'use strict';

// M9-D630 — crm.first_response_time: a média refeita do zero só com oportunidades e mensagens da fonte, resposta automática que não conta, lead sem
// resposta fora da média, fuso de São Paulo, amostra mínima (INCOMPLETE) e os parâmetros do administrador. Banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const kit = require('../_helpers/crmKpiEnv');
const { firstResponseFromSource } = require('../_helpers/crmOracle630');

const { src, at, TODAY } = kit;
let env;
let robotLeadId;
before(async () => { env = await kit.setup(); });
after(() => kit.teardown(env));

const plus = (iso, minutes, seconds = 0) => new Date(Date.parse(iso) + (minutes * 60 + seconds) * 1000).toISOString();

test('m9d630 reproduz crm.first_response_time a partir dos registros-fonte', async () => {
  const t = env.cX;
  const [b1, b2] = [src.uuid(), src.uuid()];
  const ids = [];
  const lead = async (day, source, owner) => { const created = at(day, 10); return { id: await src.opportunity(env, t, { owner, source, created }), created }; };
  // respostas humanas de 10, 20, 12, 14 e 14 min => média 14,0 min
  for (const [day, source, owner, minutes] of [[5, 'PORTAL', b1, 10], [6, 'PORTAL', b1, 20], [7, 'SITE', b2, 12], [8, 'SITE', b2, 14], [9, 'SITE', b2, 14]]) {
    const l = await lead(day, source, owner);
    ids.push(l.id);
    await src.message(env, t, { opportunity: l.id, direction: 'INBOUND', author: 'CLIENT', created: plus(l.created, 1) }); // mensagem do cliente: não é resposta
    await src.message(env, t, { opportunity: l.id, created: plus(l.created, minutes) });
  }
  const robot = await lead(10, 'SITE', b2); // só a NAY respondeu: resposta automática não conta, o lead segue sem resposta
  robotLeadId = robot.id;
  ids.push(robot.id);
  await src.message(env, t, { opportunity: robot.id, author: 'NAY', created: plus(robot.created, 1) });
  ids.push((await lead(11, 'PORTAL', b1)).id); // ninguém respondeu ainda
  await kit.refreshAll(t, ids);
  await kit.kpis(t);

  const want = await firstResponseFromSource(env, t, TODAY);
  assert.deepEqual([want.leads, want.answered, want.withoutResponse, want.average], ['7', '5', '2', '14.0']);
  const kpi = await kit.readKpi(t, 'crm.first_response_time');
  assert.deepEqual([kpi.status, kpi.unit, kpi.version, kpi.metricCode], ['OK', 'MINUTES', 1, 'crm.first_response_time']);
  assert.equal(Number(kpi.value), Number(want.average), 'a média do KPI é a da fonte, em minutos com 1 casa');
  assert.equal(Number(await kit.dimension(t, 'crm.first_response_time', 'sem_resposta_qtd')), Number(want.withoutResponse), 'leads sem resposta contados à parte');
  assert.equal(Number(await kit.dimension(t, 'crm.first_response_time', 'origem:PORTAL:tempo_min')), 15, '(10 + 20) / 2');
  assert.equal(Number(await kit.dimension(t, 'crm.first_response_time', `corretor:${b2}:tempo_min`)), 13.3, '(12 + 14 + 14) / 3 = 13,33 => 13,3');
  assert.ok(kpi.sourceSnapshotAt && kpi.refreshedAt && kpi.freshness);
  assert.equal(kpi.sourceRefs[0].table, 'crm.opportunities');
  assert.equal(kpi.sourceRefs[0].count, Number(want.leads), 'o detalhe abre os leads do período');
});

test('m9d630 crm.first_response_time fica DEGRADED com valor nulo quando a regra de qualidade falha', async () => { // amostra curta: INCOMPLETE; o lead de 23:30 conta no dia de São Paulo
  const t = env.cY;
  const first = '2026-10-29T02:30:00Z'; // 23:30 de 28/10 em SP, já 29/10 em UTC
  const ids = [];
  const addAnswered = async (i) => {
    const id = await src.opportunity(env, t, { owner: src.uuid(), source: 'SITE', created: plus(first, i) });
    ids.push(id);
    await src.message(env, t, { opportunity: id, created: plus(first, i + 1, 31) }); // resposta 1 min 31 s depois da criação
    await kit.refresh(t, id);
  };
  for (let i = 0; i < 4; i += 1) await addAnswered(i);
  await kit.kpis(t, '2026-10-28');
  const short = await kit.readKpi(t, 'crm.first_response_time', { asOfDate: '2026-10-28' });
  assert.equal(short.status, 'INCOMPLETE', '4 respondidos < mínimo de 5');
  assert.equal(short.value, null, 'nunca um número enganoso');
  await addAnswered(4);
  await kit.kpis(t, '2026-10-28');
  const want = await firstResponseFromSource(env, t, '2026-10-28');
  assert.deepEqual(want.seconds, [91, 91, 91, 91, 91], 'a fonte mede ao segundo');
  const kpi = await kit.readKpi(t, 'crm.first_response_time', { asOfDate: '2026-10-28' });
  assert.equal(kpi.status, 'OK');
  assert.equal(Number(kpi.value), 1.5, '91 s = 1,5167 min => 1,5');
  assert.equal(want.average, '1.5');
});

test('m9d630 o mínimo de respondidos é parâmetro do administrador (analytics.qualidade.min_amostra)', async () => {
  const t = env.cX;
  await kit.setSetting(env, t, 'analytics.qualidade.min_amostra', 6);
  await kit.kpis(t);
  const kpi = await kit.readKpi(t, 'crm.first_response_time');
  assert.equal(kpi.status, 'INCOMPLETE', '5 respondidos < mínimo de 6');
  assert.equal(kpi.value, null);
  await kit.setSetting(env, t, 'analytics.qualidade.min_amostra', 5);
  await kit.kpis(t);
  assert.equal((await kit.readKpi(t, 'crm.first_response_time')).status, 'OK');
});

test('m9d630 a resposta da NAY só conta se o administrador ligar analytics.comercial.primeira_resposta_inclui_nay', async () => {
  const t = env.cX;
  await kit.setSetting(env, t, 'analytics.comercial.primeira_resposta_inclui_nay', true);
  await kit.refresh(t, robotLeadId);
  await kit.kpis(t);
  const want = await firstResponseFromSource(env, t, TODAY, { includeNay: true });
  assert.deepEqual([want.answered, want.withoutResponse], ['6', '1']);
  assert.equal(Number((await kit.readKpi(t, 'crm.first_response_time')).value), Number(want.average), 'com a NAY contando a média é a da fonte com a NAY');
  assert.equal(Number(await kit.dimension(t, 'crm.first_response_time', 'sem_resposta_qtd')), 1);
});
