'use strict';

// M9-D633 — com a regra de qualidade violada, cada KPI sai DEGRADED/INCOMPLETE e com valor nulo (nunca um número enganoso); os limites são parâmetros do
// administrador (analytics.qualidade.max_sem_corretor_pct e analytics.qualidade.min_amostra). Banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const sc = require('../_helpers/m9d633Scenario');

const { src } = sc;
let env;
const ana = sc.src.uuid();
before(async () => {
  env = await sc.setup();
  await sc.setSetting(env, env.cX, 'analytics.qualidade.max_nulos_pct.created_by', 50); // o rebuild só bloqueia pelo limite do check de completude (D696); o KPI tem o seu
});
after(() => sc.teardown(env));

const wipe = async (tables) => {
  await env.admin.transaction(async (transaction) => {
    await env.admin.query("SET LOCAL session_replication_role = 'replica'", { transaction });
    for (const t of tables) await env.admin.query(`DELETE FROM ${t} WHERE company_id = :c`, { replacements: { c: env.cX.companyId }, transaction });
  });
};
const run = async (code, model) => {
  await sc.refreshModels(env.cX, [model]);
  await sc.kpis(env.cX, { only: [code] });
  return sc.readKpi(env.cX, code);
};
const isNull = (v) => v === null || v === undefined;

test('m9d633 radar.matches fica DEGRADED com valor nulo quando a regra de qualidade falha', async () => {
  const property = await sc.property(env, env.cX, { publishedAt: sc.iso('2026-10-10'), offers: ['SALE'], createdBy: ana });
  const radar = await sc.radar(env, env.cX, { createdBy: ana });
  await sc.match(env, env.cX, { radar, person: src.uuid(), property, at: sc.iso('2026-10-12') });
  const ok = await run('radar.matches', 'rm_radar_matches');
  assert.deepEqual([ok.status, Number(ok.value)], ['OK', 1]);
  await sc.match(env, env.cX, { radar: src.uuid(), person: src.uuid(), property, at: sc.iso('2026-10-13') }); // cruzamento sem perfil (radar inexistente)
  const noProfile = await run('radar.matches', 'rm_radar_matches');
  assert.equal(noProfile.status, 'DEGRADED');
  assert.ok(isNull(noProfile.value), 'sem valor: nunca um número enganoso');
  await wipe(['integration.outbox_events']);
  await sc.match(env, env.cX, { radar, person: src.uuid(), property: src.uuid(), at: sc.iso('2026-10-13') }); // imóvel que não existe
  const noProperty = await run('radar.matches', 'rm_radar_matches');
  assert.equal(noProperty.status, 'DEGRADED');
  assert.ok(isNull(noProperty.value));
  await wipe(['integration.outbox_events', 'crm.property_radars', 'real_estate.property_offers', 'real_estate.properties']);
});

test('m9d633 crm.broker_capture fica DEGRADED com valor nulo quando a regra de qualidade falha', async () => {
  const mk = (createdBy) => sc.property(env, env.cX, { createdBy, created: sc.iso('2026-10-05'), publishedAt: sc.iso('2026-10-06') });
  for (let i = 0; i < 19; i += 1) await mk(ana);
  await mk(null); // 1 de 20 = 5,00%: no limite, ainda vale
  const ok = await run('crm.broker_capture', 'rm_broker_performance');
  assert.deepEqual([ok.status, Number(ok.value)], ['OK', 20]);
  await mk(null); // 2 de 21 = 9,52%: acima do limite padrão de 5%
  const bad = await run('crm.broker_capture', 'rm_broker_performance');
  assert.equal(bad.status, 'DEGRADED');
  assert.ok(isNull(bad.value));
  assert.equal(Number((await sc.readKpi(env.cX, 'crm.broker_capture', { dimensionKey: 'sem_captador' })).value), 2, 'o "Sem captador" continua à vista');
  await sc.setSetting(env, env.cX, 'analytics.qualidade.max_sem_corretor_pct', 10); // o limite é parâmetro do administrador
  const relaxed = await run('crm.broker_capture', 'rm_broker_performance');
  assert.deepEqual([relaxed.status, Number(relaxed.value)], ['OK', 21]);
  await wipe(['real_estate.property_offers', 'real_estate.properties']);
});

test('m9d633 crm.broker_conversion fica INCOMPLETE com valor nulo quando a regra de qualidade falha', async () => {
  const mk = (stage) => src.opportunity(env, env.cX, { owner: ana, stage, created: sc.iso('2026-09-01'), closedAt: sc.iso('2026-10-15'), lostReason: stage === 'CLOSED_LOST' ? 'PRICE' : null });
  await mk('CLOSED_WON');
  await mk('CLOSED_LOST');
  await mk('CLOSED_LOST');
  const bad = await run('crm.broker_conversion', 'rm_broker_performance');
  assert.equal(bad.status, 'INCOMPLETE', '3 fechadas, abaixo da amostra mínima de 5');
  assert.ok(isNull(bad.value));
  await sc.setSetting(env, env.cX, 'analytics.qualidade.min_amostra', 3); // a amostra mínima é parâmetro do administrador
  const ok = await run('crm.broker_conversion', 'rm_broker_performance');
  assert.equal(ok.status, 'OK');
  assert.equal(Number(ok.value), 33.33);
  assert.equal(Number((await sc.readKpi(env.cX, 'crm.broker_conversion', { dimensionKey: `corretor:${ana}:taxa_pct` })).value), 33.33);
});
