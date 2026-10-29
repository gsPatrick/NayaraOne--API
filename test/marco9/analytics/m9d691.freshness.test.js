'use strict';

// M9-D691 + M9-D609 (provados em conjunto) — o alerta técnico `analytics.freshness.stale` vira instância no alert engine, e os alertas semente
// nascem dos parâmetros do administrador. Banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const e = require('../_helpers/m9d691Env');

let env;
let tenant;
before(async () => { env = await e.setup(); tenant = env.tenantA; });
after(() => e.teardown(env));

const D = '2026-10-29';
const at = (hhmm) => new Date(`${D}T${hhmm}:00Z`).toISOString();
const freshnessRows = async (metric) => (await e.instances(env, tenant)).filter((r) => r.metric_code === metric.code && r.alert_code === 'analytics_freshness_critica');

test('m9d691 snapshot antigo de métrica crítica abre o alerta de freshness e resolve quando o dado volta', async () => {
  env.events.length = 0;
  const metric = await e.publish(env, tenant, { prefix: 'fin', criticality: 'CRITICAL' });
  const normal = await e.publish(env, tenant, { prefix: 'fin', criticality: 'NORMAL' });
  // lido às 12:00, a fonte é das 09:00: 180 min para o limite de 60 (STALE)
  await e.put(tenant, metric, { value: '100', at: at('12:00'), sourceAt: at('09:00') });
  await e.put(tenant, normal, { value: '100', at: at('12:00'), sourceAt: at('09:00') });
  await e.engine.evaluateCompanyAlerts({ companyId: tenant.companyId, groupId: tenant.groupId }, { now: new Date(at('12:00')) });
  let rows = await freshnessRows(metric);
  assert.equal(rows.length, 1, 'abre o alerta técnico');
  assert.deepEqual([rows[0].status, rows[0].severity], ['OPEN', 'WARNING'], 'WARNING, o padrão do alerta semente de freshness');
  assert.equal((await freshnessRows(normal)).length, 0, 'métrica NORMAL não tem alerta de freshness');
  assert.equal(env.events.filter((x) => x.type === 'analytics.alert.opened' && x.metricCode === metric.code).length, 1);
  // repete a avaliação com o dado ainda velho: a mesma instância
  await e.put(tenant, metric, { value: '100', at: at('12:10'), sourceAt: at('09:00') });
  await e.engine.evaluateCompanyAlerts({ companyId: tenant.companyId, groupId: tenant.groupId }, { now: new Date(at('12:10')) });
  rows = await freshnessRows(metric);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].occurrence_count, 2);
  // o dado volta a ser lido: duas avaliações em dia resolvem
  for (const hhmm of ['12:20', '12:30']) {
    await e.put(tenant, metric, { value: '100', at: at(hhmm), sourceAt: at(hhmm) });
    await e.engine.evaluateCompanyAlerts({ companyId: tenant.companyId, groupId: tenant.groupId }, { now: new Date(at(hhmm)) });
  }
  rows = await freshnessRows(metric);
  assert.equal(rows[0].status, 'RESOLVED');
  assert.equal(rows[0].resolved_reason, 'CONDITION_NORMALIZED');
  // dado EXPIRED também alerta (e continua o mesmo problema de freshness)
  await e.put(tenant, metric, { value: '100', at: at('18:00'), sourceAt: at('09:00') });
  await e.engine.evaluateCompanyAlerts({ companyId: tenant.companyId, groupId: tenant.groupId }, { now: new Date('2026-10-30T02:00:00Z') });
  assert.equal((await freshnessRows(metric)).length, 2, 'nova ocorrência depois do cooldown abre outra instância');
});

test('m9d691 os alertas semente nascem dos parâmetros e acompanham o que o administrador muda', async () => {
  await e.engine.syncSeedAlerts({ companyId: tenant.companyId, groupId: tenant.groupId });
  const defs = async () => (await env.admin.query("SELECT alert_code, metric_code, condition_type, threshold, severity, owner_role, create_task, status, scope, version FROM analytics.alert_definitions WHERE company_id = :c AND status = 'PUBLISHED' ORDER BY alert_code",
    { replacements: { c: tenant.companyId } }))[0];
  let list = await defs();
  const byCode = Object.fromEntries(list.map((d) => [d.alert_code, d]));
  assert.deepEqual(Object.keys(byCode).filter((c) => /^(fin_|analytics_|legal_|rent_|tec_|ai_)/.test(c)).sort(), [
    'ai_orcamento', 'analytics_freshness_critica', 'fin_breathing_need', 'fin_free_cash_baixo', 'legal_prazo_vencido', 'rent_garantia_30d', 'tec_integracao_erro',
  ]);
  assert.deepEqual([byCode.fin_free_cash_baixo.metric_code, byCode.fin_free_cash_baixo.threshold, byCode.fin_free_cash_baixo.severity], ['fin.free_cash', { operator: 'LT', value: 50000 }, 'WARNING']);
  assert.deepEqual([byCode.fin_breathing_need.threshold, byCode.fin_breathing_need.severity], [{ operator: 'GT', value: 0 }, 'WARNING']);
  assert.deepEqual([byCode.legal_prazo_vencido.threshold, byCode.legal_prazo_vencido.severity, byCode.legal_prazo_vencido.create_task], [{ operator: 'GT', value: 0 }, 'CRITICAL', true]);
  assert.deepEqual([byCode.tec_integracao_erro.threshold, byCode.tec_integracao_erro.severity], [{ operator: 'GT', value: 10 }, 'CRITICAL']);
  assert.deepEqual([byCode.ai_orcamento.threshold, byCode.ai_orcamento.severity], [{ operator: 'GT', value: 80 }, 'WARNING']);
  assert.deepEqual([byCode.rent_garantia_30d.threshold, byCode.rent_garantia_30d.scope.dimensionKey], [{ operator: 'GT', value: 0 }, '30d']);
  assert.ok(byCode.fin_free_cash_baixo.owner_role, 'todo alerta tem owner');
  // idempotente
  await e.engine.syncSeedAlerts({ companyId: tenant.companyId, groupId: tenant.groupId });
  assert.equal((await defs()).length, list.length);
  // o administrador muda o limite: nova versão publicada e a anterior sai de cena
  await e.setSetting(env, tenant, 'analytics.alerta_semente.fin_free_cash_baixo', 'fin.free_cash < R$ 75.000,50, CRITICAL');
  await e.engine.syncSeedAlerts({ companyId: tenant.companyId, groupId: tenant.groupId });
  list = await defs();
  const updated = list.find((d) => d.alert_code === 'fin_free_cash_baixo');
  assert.deepEqual([updated.threshold, updated.severity, updated.version], [{ operator: 'LT', value: 75000.5 }, 'CRITICAL', 2]);
  assert.equal(list.filter((d) => d.alert_code === 'fin_free_cash_baixo').length, 1, 'só uma versão publicada');
  // texto fora do formato volta ao padrão, nunca quebra
  await e.setSetting(env, tenant, 'analytics.alerta_semente.fin_free_cash_baixo', 'qualquer coisa');
  await e.engine.syncSeedAlerts({ companyId: tenant.companyId, groupId: tenant.groupId });
  const back = (await defs()).find((d) => d.alert_code === 'fin_free_cash_baixo');
  assert.deepEqual(back.threshold, { operator: 'LT', value: 50000 });
  const { SETTINGS_SCHEMA } = require('../../../src/features/settings/settings.service');
  assert.throws(() => SETTINGS_SCHEMA['analytics.alerta_semente.fin_free_cash_baixo'].validate('analytics.alerta_semente.fin_free_cash_baixo', 'qualquer coisa'), /formato/i);
});

test('m9d691 limiar semente alterado instantaneamente resolve a instância do limiar antigo', async () => {
  const metric = await e.publish(env, tenant, { prefix: 'fin' });
  const def = await e.defineAlert(tenant, metric);
  await e.put(tenant, metric, { value: '1000', at: at('16:00') });
  await e.evaluate(tenant, at('16:00'));
  assert.equal((await e.instances(env, tenant, def))[0].status, 'OPEN');
  // a definição passa a ter outro limite (mesmo código): o fingerprint muda e a instância do limiar antigo é encerrada
  await e.sup.inTx(tenant, { commit: true }, async (tx) => {
    await e.store.enableAnalyticsWriter(tx);
    await e.sup.sequelize.query("UPDATE analytics.alert_definitions SET threshold = CAST('{\"operator\":\"LT\",\"value\":500}' AS jsonb) WHERE id = :id", { replacements: { id: def.id }, transaction: tx });
  });
  await e.put(tenant, metric, { value: '1000', at: at('16:10') });
  await e.evaluate(tenant, at('16:10'));
  const rows = await e.instances(env, tenant, def);
  assert.equal(rows[0].status, 'RESOLVED');
  assert.equal(rows[0].resolved_reason, 'DEFINITION_CHANGED');
});
