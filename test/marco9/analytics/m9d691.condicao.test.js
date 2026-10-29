'use strict';

// M9-D691 (Guia §7) — fingerprint, condição por limite e por regra do Motor de Regras, métrica degradada em espera e transições proibidas.
// Banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const e = require('../_helpers/m9d691Env');

let env;
let tenant;
before(async () => { env = await e.setup(); tenant = env.tenantA; });
after(() => e.teardown(env));

const D = '2026-10-29';
const at = (hhmm) => new Date(`${D}T${hhmm}:00Z`).toISOString();
const COMPANY = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

test('m9d691 fingerprint é igual para o mesmo problema e diferente para outro escopo', () => {
  const base = { metricCode: 'fin.free_cash', companyId: COMPANY, scope: { dimensionKey: '' }, condition: { type: 'THRESHOLD', operator: 'LT', value: 50000 } };
  const f = e.engine.fingerprintOf(base);
  assert.match(f, /^[0-9a-f]{64}$/);
  assert.equal(e.engine.fingerprintOf({ ...base }), f, 'determinístico');
  assert.equal(e.engine.fingerprintOf({ ...base, scope: { dimensionKey: '' }, condition: { value: 50000, operator: 'LT', type: 'THRESHOLD' } }), f, 'a ordem das chaves não muda o resultado');
  assert.equal(e.engine.fingerprintOf({ ...base, condition: { ...base.condition, value: 50000.0 } }), f, '50000 e 50000.0 são o mesmo número');
  assert.notEqual(e.engine.fingerprintOf({ ...base, companyId: OTHER }), f, 'outra empresa');
  assert.notEqual(e.engine.fingerprintOf({ ...base, scope: { dimensionKey: 'vencidos' } }), f, 'outra dimensão');
  assert.notEqual(e.engine.fingerprintOf({ ...base, metricCode: 'fin.breathing_need' }), f, 'outra métrica');
  assert.notEqual(e.engine.fingerprintOf({ ...base, condition: { ...base.condition, operator: 'LTE' } }), f, 'outro operador');
  assert.notEqual(e.engine.fingerprintOf({ ...base, condition: { ...base.condition, value: 40000 } }), f, 'outro valor');
  assert.notEqual(e.engine.fingerprintOf({ ...base, condition: { type: 'RULE_ENGINE', ruleId: 'r1', ruleVersion: 1 } }), f, 'regra no lugar de limite');
  assert.notEqual(e.engine.fingerprintOf({ ...base, condition: { type: 'RULE_ENGINE', ruleId: 'r1', ruleVersion: 2 } }), e.engine.fingerprintOf({ ...base, condition: { type: 'RULE_ENGINE', ruleId: 'r1', ruleVersion: 1 } }), 'versão da regra');
});

test('m9d691 operadores do limite comparam número decimal sem erro de ponto flutuante', () => {
  const cmp = e.engine.compareThreshold;
  assert.equal(cmp('0.1000', 'LT', 0.2), true);
  assert.equal(cmp('0.3000', 'EQ', 0.3), true);
  assert.equal(cmp('50000.0000', 'LT', 50000), false);
  assert.equal(cmp('50000.0000', 'LTE', 50000), true);
  assert.equal(cmp('50000.0001', 'GT', 50000), true);
  assert.equal(cmp('50000.0000', 'GTE', 50000), true);
  assert.equal(cmp('49999.9999', 'NEQ', 50000), true);
  assert.equal(cmp('-5.0000', 'LT', 0), true);
  assert.equal(cmp('12345678901234.5678', 'GT', 12345678901234.56), true);
  assert.throws(() => cmp('1', 'XX', 1), /operador/i);
});

test('m9d691 métrica DEGRADED não dispara por valor', async () => {
  const metric = await e.publish(env, tenant, { prefix: 'fin', criticality: 'CRITICAL' });
  const def = await e.defineAlert(tenant, metric);
  await e.put(tenant, metric, { value: '1000', at: at('09:00'), status: 'DEGRADED' });
  let res = await e.evaluate(tenant, at('09:00'));
  assert.equal((await e.instances(env, tenant, def)).length, 0, 'DEGRADED: valor baixo mas não dispara');
  assert.equal(res.results.find((r) => r.alertCode === def.alert_code).action, 'ON_HOLD');
  await e.put(tenant, metric, { value: '1000', at: at('09:10'), status: 'INCOMPLETE' });
  res = await e.evaluate(tenant, at('09:10'));
  assert.equal((await e.instances(env, tenant, def)).length, 0, 'INCOMPLETE idem');
  // freshness EXPIRED (inclui DEGRADED pela M9-D609): dado de 5 h para o limite de 60 min
  await e.put(tenant, metric, { value: '1000', at: at('09:20'), sourceAt: '2026-10-29T04:00:00Z' });
  res = await e.evaluate(tenant, at('09:20'));
  assert.equal((await e.instances(env, tenant, def)).length, 0, 'EXPIRED: em espera');
  assert.equal(res.results.find((r) => r.alertCode === def.alert_code).action, 'ON_HOLD');
  // sem nenhum snapshot: em espera
  const empty = await e.publish(env, tenant, { prefix: 'fin' });
  const emptyDef = await e.defineAlert(tenant, empty);
  res = await e.evaluate(tenant, at('09:30'));
  assert.equal(res.results.find((r) => r.alertCode === emptyDef.alert_code).action, 'ON_HOLD');
  // voltou a ser confiável: dispara
  await e.put(tenant, metric, { value: '1000', at: at('09:40') });
  await e.evaluate(tenant, at('09:40'));
  assert.equal((await e.instances(env, tenant, def)).length, 1);
});

test('m9d691 métrica DEGRADED não resolve nem conta avaliação normal de um alerta aberto', async () => {
  const metric = await e.publish(env, tenant, { prefix: 'fin' });
  const def = await e.defineAlert(tenant, metric);
  await e.put(tenant, metric, { value: '1000', at: at('10:00') });
  await e.evaluate(tenant, at('10:00'));
  await e.put(tenant, metric, { value: '90000', at: at('10:05'), status: 'DEGRADED' });
  await e.evaluate(tenant, at('10:05'));
  const [row] = await e.instances(env, tenant, def);
  assert.deepEqual([row.status, row.normal_streak, row.occurrence_count], ['OPEN', 0, 1], 'valor não confiável não normaliza nem repete');
});

test('m9d691 definição RULE_ENGINE usa só regra publicada', async () => {
  const metric = await e.publish(env, tenant, { prefix: 'fin' });
  const rule = await e.seedRule(env, tenant, { op: '<', limit: 50000 });
  const def = await e.defineAlert(tenant, metric, { ruleId: rule.id });
  assert.equal(def.condition_type, 'RULE_ENGINE');
  await e.put(tenant, metric, { value: '60000', at: at('10:00') });
  await e.evaluate(tenant, at('10:00'));
  assert.equal((await e.instances(env, tenant, def)).length, 0, 'regra não casou: sem alerta');
  await e.put(tenant, metric, { value: '42000', at: at('10:10') });
  await e.evaluate(tenant, at('10:10'));
  const rows = await e.instances(env, tenant, def);
  assert.equal(rows.length, 1, 'a decisão da regra publicada abre o alerta');
  assert.equal(rows[0].severity, 'WARNING');
  assert.match(rows[0].fingerprint, /^[0-9a-f]{64}$/);
  // regra que deixou de estar publicada nunca roda: a definição falha, nada muda
  await e.retireRule(env, rule);
  await e.put(tenant, metric, { value: '41000', at: at('10:20') });
  const res = await e.evaluate(tenant, at('10:20'));
  const failed = res.failed.find((f) => f.alertCode === def.alert_code);
  assert.ok(failed, 'a falha da definição é devolvida');
  assert.equal(failed.errorCode, 'ANALYTICS_ALERT_RULE_NOT_PUBLISHED');
  assert.equal((await e.instances(env, tenant, def))[0].occurrence_count, 1, 'a regra fora de publicação não conta ocorrência');
  // o banco já recusa definição apontando para regra em rascunho (D602, 422)
  const draft = await e.seedRule(env, tenant, { published: false });
  await assert.rejects(e.defineAlert(tenant, metric, { ruleId: draft.id }), (err) => err.statusCode === 422 && err.code === 'ANALYTICS_ALERT_RULE_NOT_PUBLISHED');
});

test('m9d691 transições proibidas retornam 409', async () => {
  const { assertTransition } = e.engine;
  for (const [from, to] of [['OPEN', 'ACKNOWLEDGED'], ['OPEN', 'RESOLVED'], ['ACKNOWLEDGED', 'RESOLVED']]) assert.doesNotThrow(() => assertTransition(from, to), `${from} -> ${to}`);
  for (const [from, to] of [['RESOLVED', 'OPEN'], ['RESOLVED', 'ACKNOWLEDGED'], ['ACKNOWLEDGED', 'OPEN'], ['OPEN', 'OPEN'], ['RESOLVED', 'RESOLVED']]) {
    assert.throws(() => assertTransition(from, to), (err) => {
      assert.equal(err.statusCode, 409);
      assert.equal(err.code, 'ANALYTICS_ALERT_INVALID_TRANSITION');
      assert.equal(err.message, `Transição de alerta inválida: ${from} -> ${to}.`);
      return true;
    }, `${from} -> ${to}`);
  }
  // na instância real: RESOLVED é final e o motor recusa mexer nela
  const metric = await e.publish(env, tenant, { prefix: 'fin' });
  const def = await e.defineAlert(tenant, metric);
  await e.put(tenant, metric, { value: '1000', at: at('11:00') });
  await e.evaluate(tenant, at('11:00'));
  await e.put(tenant, metric, { value: '90000', at: at('11:05') });
  await e.evaluate(tenant, at('11:05'));
  await e.put(tenant, metric, { value: '90000', at: at('11:10') });
  await e.evaluate(tenant, at('11:10'));
  const [row] = await e.instances(env, tenant, def);
  assert.equal(row.status, 'RESOLVED');
  for (const to of ['OPEN', 'ACKNOWLEDGED']) {
    await assert.rejects(e.sup.inTx(tenant, { commit: true }, async (tx) => {
      await e.store.enableAnalyticsWriter(tx);
      return e.engine.transitionAlert(row.id, to, sup(tenant), tx);
    }), (err) => err.statusCode === 409 && err.code === 'ANALYTICS_ALERT_INVALID_TRANSITION' && err.message === `Transição de alerta inválida: RESOLVED -> ${to}.`);
  }
  assert.equal((await e.instances(env, tenant, def))[0].status, 'RESOLVED', 'nada mudou');
});

function sup(t) { return { groupId: t.groupId, companyId: t.companyId, actorUserId: t.userId, permissions: ['analytics:manage'] }; }
