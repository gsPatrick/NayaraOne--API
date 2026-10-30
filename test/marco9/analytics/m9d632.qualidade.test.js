'use strict';

// M9-D632 — com a regra de qualidade violada, cada KPI sai DEGRADED/INCOMPLETE e com valor nulo (nunca um número enganoso); corrigido o dado, o número volta.
// Cada teste monta uma mini-fonte na empresa X, reconstrói o read model e recalcula o KPI (banco descartável).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const sc = require('../_helpers/m9d632Scenario');
const { storedDimension } = require('../_helpers/biStoredSnapshot');

const { src } = sc;
let env;
const broker = sc.src.uuid();
before(async () => { env = await sc.setup(); });
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

test('m9d632 crm.visits fica DEGRADED com valor nulo quando a regra de qualidade falha', async () => {
  const good = await sc.visit(env, env.cX, { at: sc.iso('2026-10-10'), status: 'DONE', agent: broker });
  const ok = await run('crm.visits', 'rm_crm_visits_proposals');
  assert.deepEqual([ok.status, Number(ok.value)], ['OK', 1]);
  await sc.visit(env, env.cX, { at: sc.iso('2026-10-11'), status: 'SCHEDULED', agent: null }); // visita sem corretor
  const bad = await run('crm.visits', 'rm_crm_visits_proposals');
  assert.equal(bad.status, 'DEGRADED');
  assert.ok(isNull(bad.value), 'sem valor: nunca um número enganoso');
  await src.update(env, 'crm.visits', good, { agent_user_id: broker });
  await wipe(['crm.visits']);
});

test('m9d632 crm.proposals fica DEGRADED com valor nulo quando a regra de qualidade falha', async () => {
  const opp = (await src.opportunity(env, env.cX, { owner: broker, created: sc.iso('2026-10-01') }));
  const mk = (value) => src.insert(env, 'crm.proposals', env.cX, { opportunity_id: opp, value, status: 'SENT', sent_at: sc.iso('2026-10-15'), version_number: Math.floor(Math.random() * 1e6) });
  await mk('1000.00');
  const ok = await run('crm.proposals', 'rm_crm_visits_proposals');
  assert.deepEqual([ok.status, Number(ok.value)], ['OK', 1]);
  await mk('0.00'); // proposta sem valor
  const bad = await run('crm.proposals', 'rm_crm_visits_proposals');
  assert.equal(bad.status, 'DEGRADED');
  assert.ok(isNull(bad.value));
  await wipe(['crm.proposals']);
});

test('m9d632 prop.active_properties fica DEGRADED com valor nulo quando a regra de qualidade falha', async () => {
  const id = await sc.property(env, env.cX, { publishedAt: sc.iso('2026-10-10'), offers: ['SALE'], createdBy: broker });
  const ok = await run('prop.active_properties', 'rm_property_portfolio');
  assert.deepEqual([ok.status, Number(ok.value)], ['OK', 1]);
  await src.update(env, 'real_estate.properties', id, { availability_status: '' }); // imóvel sem status
  const bad = await run('prop.active_properties', 'rm_property_portfolio');
  assert.equal(bad.status, 'DEGRADED');
  assert.ok(isNull(bad.value));
  await wipe(['real_estate.property_offers', 'real_estate.properties']);
});

test('m9d632 prop.without_sale_by_period fica DEGRADED com valor nulo quando a regra de qualidade falha', async () => {
  const id = await sc.property(env, env.cX, { publishedAt: sc.iso('2026-10-10'), offers: ['SALE'], createdBy: broker });
  const ok = await run('prop.without_sale_by_period', 'rm_property_portfolio');
  assert.deepEqual([ok.status, Number(ok.value)], ['OK', 1]);
  await src.update(env, 'real_estate.properties', id, { published_at: null }); // publicado, mas sem data de entrada no mercado
  const bad = await run('prop.without_sale_by_period', 'rm_property_portfolio');
  assert.equal(bad.status, 'DEGRADED');
  assert.ok(isNull(bad.value));
  assert.ok(isNull((await sc.readKpi(env.cX, 'prop.without_sale_by_period', { dimensionKey: 'sem_data' })).value), 'a API nunca devolve número de KPI DEGRADED, nem o de uma dimensão (M9-D697)');
  assert.equal(Number(await storedDimension(env, env.cX, 'prop.without_sale_by_period', 'sem_data', sc.TODAY)), 1, 'o snapshot gravado conta o imóvel em "Sem data"');
  await wipe(['real_estate.property_offers', 'real_estate.properties']);
});

test('m9d632 prop.price_changes fica INCOMPLETE com valor nulo quando só há primeira entrada de histórico', async () => {
  await src.priceHistory(env, env.cX, { oldPrice: '100.00', newPrice: '110.00', at: sc.iso('2026-10-10') });
  const ok = await run('prop.price_changes', 'rm_property_price_changes');
  assert.deepEqual([ok.status, Number(ok.value)], ['OK', 1]);
  await wipe(['real_estate.property_price_history']);
  await src.priceHistory(env, env.cX, { oldPrice: '0.00', newPrice: '110.00', at: sc.iso('2026-10-10') }); // sem preço anterior
  const bad = await run('prop.price_changes', 'rm_property_price_changes');
  assert.equal(bad.status, 'INCOMPLETE');
  assert.ok(isNull(bad.value), 'a variação não existe: sem valor, nunca 0%');
});
