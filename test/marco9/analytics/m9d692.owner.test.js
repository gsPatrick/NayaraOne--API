'use strict';

// M9-D692 (Caderno §16 e BI-011) — todo alerta tem owner e severidade; owner por papel avisa todos os ativos do papel; owner inativo cai no
// reserva (analytics.alert.owner_reserva) e registra o evento; mudar o owner é auditado. Banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const e = require('../_helpers/m9d692Env');

let env;
let tenant;
before(async () => { env = await e.setup(); tenant = env.tenantA; });
after(() => e.teardown(env));

const at = (hhmm) => new Date(`2026-10-29T${hhmm}:00Z`).toISOString();
const open = async (metric, hhmm, value = '10') => { await e.put(tenant, metric, { value, at: at(hhmm) }); return e.evaluate(tenant, at(hhmm)); };

test('m9d692 alerta sem owner é recusado', async () => {
  const metric = await e.publish(env, tenant, { prefix: 'fin', criticality: 'CRITICAL' });
  await assert.rejects(
    e.define(env, tenant, metric, { ownerRole: null }),
    (err) => err.statusCode === 422 && err.code === 'ANALYTICS_ALERT_OWNER_REQUIRED' && err.message === 'Todo alerta precisa de um responsável (owner).'
  );
});

test('m9d692 definição com ação financeira é recusada', async () => {
  const metric = await e.publish(env, tenant, { prefix: 'fin', criticality: 'CRITICAL' });
  const input = { scopeLevel: 'COMPANY', companyId: tenant.companyId, groupId: tenant.groupId, metricCode: metric.code, conditionType: 'THRESHOLD', threshold: { operator: 'LT', value: 1 }, severity: 'CRITICAL', ownerRole: 'CFO' };
  const variants = [{ scope: { pagamento: true } }, { scope: { regras: [{ pix: 1 }] } }, { action: 'pagar_boleto' }, { actions: [{ type: 'PAYMENT' }] }, { onTrigger: { transfer: 10 } }];
  for (const extra of variants) {
    await assert.rejects(
      e.sup.inTx(tenant, { commit: true }, async (tx) => { await e.store.enableAnalyticsWriter(tx); return e.alertDefs.createAlertDefinition({ ...input, alertCode: `al_${e.sup.sfx()}`, ...extra }, e.sup.ctxOf(tenant), tx); }),
      (err) => err.statusCode === 422 && err.code === 'ANALYTICS_ALERT_ACTION_FORBIDDEN' && err.message === 'Alerta não pode disparar pagamento.', JSON.stringify(extra)
    );
  }
});

test('m9d692 owner por papel notifica todos os usuários ativos do papel, sem valor no corpo', async () => {
  const metric = await e.publish(env, tenant, { prefix: 'fin', criticality: 'CRITICAL' });
  const role = await e.makeRole(env, tenant);
  const active = [await e.makeUser(env, tenant, { role }), await e.makeUser(env, tenant, { role })];
  const inactive = await e.makeUser(env, tenant, { role, status: 'INACTIVE', membership: 'INACTIVE' });
  const def = await e.define(env, tenant, metric, { severity: 'WARNING', ownerRole: role.name });
  await open(metric, '09:00', '12345.67');
  const [instance] = await e.instances(env, tenant, def);
  const notes = await e.notificationsOf(env, tenant, instance.id);
  assert.deepEqual(notes.map((n) => n.user_id).sort(), [...active].sort(), 'só os ativos do papel');
  assert.ok(!notes.some((n) => n.user_id === inactive));
  for (const n of notes) {
    assert.equal(n.channel, 'IN_APP');
    assert.match(n.title, new RegExp(def.alert_code));
    assert.match(n.title, /ATENÇÃO|WARNING|Atenção/i, 'a gravidade vai no título');
    assert.doesNotMatch(`${n.title} ${n.body}`, /12345|12\.345/, 'sigilo: o valor da métrica não vai no aviso');
    assert.match(n.body, new RegExp(`/painel/.*${instance.id}`), 'o link do painel leva o alerta');
  }
  await open(metric, '09:10', '11000'); // repetição: sem novo aviso
  assert.equal((await e.notificationsOf(env, tenant, instance.id)).length, 2);
});

test('m9d692 owner usuário recebe o aviso e a tarefa', async () => {
  const metric = await e.publish(env, tenant, { prefix: 'fin', criticality: 'CRITICAL' });
  const user = await e.makeUser(env, tenant);
  const def = await e.defineForUser(env, tenant, metric, user, { severity: 'CRITICAL', createTask: true });
  await open(metric, '09:20');
  const [instance] = await e.instances(env, tenant, def);
  assert.deepEqual((await e.notificationsOf(env, tenant, instance.id)).map((n) => n.user_id), [user]);
  assert.equal((await e.tasksOf(env, tenant)).find((t) => t.id === instance.task_id).assigned_to_user_id, user);
});

test('m9d692 owner inativo usa fallback e registra evento', async () => {
  const metric = await e.publish(env, tenant, { prefix: 'fin', criticality: 'CRITICAL' });
  const reserva = await e.makeRole(env, tenant);
  const diretor = await e.makeUser(env, tenant, { role: reserva });
  await e.setSetting(env, tenant, 'analytics.alert.owner_reserva', reserva.name);
  const gone = await e.makeUser(env, tenant, { status: 'INACTIVE', membership: 'INACTIVE' });
  const def = await e.defineForUser(env, tenant, metric, gone, { severity: 'CRITICAL', createTask: true });
  env.events.length = 0;
  await open(metric, '09:30');
  const [instance] = await e.instances(env, tenant, def);
  assert.deepEqual((await e.notificationsOf(env, tenant, instance.id)).map((n) => n.user_id), [diretor], 'o reserva recebeu o aviso');
  assert.equal((await e.tasksOf(env, tenant)).find((t) => t.id === instance.task_id).assigned_to_user_id, diretor, 'e a tarefa');
  const fallback = env.events.filter((ev) => ev.type === 'analytics.alert.owner_fallback');
  assert.equal(fallback.length, 1);
  assert.equal(fallback[0].instanceId, instance.id);
  assert.equal(fallback[0].fallbackRole, reserva.name);
  assert.equal(fallback[0].reason, 'OWNER_USER_INACTIVE');
  const trail = (await e.auditOf(env, tenant, 'analytics.alert.owner_fallback')).filter((r) => r.entity_id === instance.id);
  assert.equal(trail.length, 1, 'o fato também fica na trilha de auditoria');
  await env.admin.query("DELETE FROM core.tenant_settings WHERE company_id = :c AND key = 'analytics.alert.owner_reserva'", { replacements: { c: tenant.companyId } });
});

test('m9d692 papel do owner sem ninguém ativo cai no reserva padrão Diretoria', async () => {
  const metric = await e.publish(env, tenant, { prefix: 'fin', criticality: 'CRITICAL' });
  const diretoria = await e.makeRole(env, tenant, 'Diretoria');
  const diretor = await e.makeUser(env, tenant, { role: diretoria });
  const vazio = await e.makeRole(env, tenant);
  const def = await e.define(env, tenant, metric, { ownerRole: vazio.name });
  env.events.length = 0;
  await open(metric, '09:40');
  const [instance] = await e.instances(env, tenant, def);
  assert.ok((await e.notificationsOf(env, tenant, instance.id)).some((n) => n.user_id === diretor));
  assert.equal(env.events.filter((ev) => ev.type === 'analytics.alert.owner_fallback' && ev.reason === 'OWNER_ROLE_EMPTY').length, 1);
});

test('m9d692 mudar o owner da definição é auditado com antes e depois', async () => {
  const metric = await e.publish(env, tenant, { prefix: 'fin', criticality: 'CRITICAL' });
  const def = await e.define(env, tenant, metric, { ownerRole: 'CFO' });
  const user = await e.makeUser(env, tenant);
  const changed = await e.sup.inTx(tenant, { commit: true }, async (tx) => {
    await e.store.enableAnalyticsWriter(tx);
    return e.engine.changeAlertOwner(def.id, { ownerUserId: user, ownerRole: null }, e.sup.ctxOf(tenant), tx);
  });
  assert.equal(changed.owner_user_id, user);
  assert.equal(changed.owner_role, null);
  const [row] = (await e.auditOf(env, tenant, 'analytics.alert.owner_change')).filter((r) => r.entity_id === def.id);
  assert.deepEqual(row.before_json, { ownerUserId: null, ownerRole: 'CFO' });
  assert.deepEqual(row.after_json, { ownerUserId: user, ownerRole: null });
  await assert.rejects(
    e.sup.inTx(tenant, { commit: true }, async (tx) => { await e.store.enableAnalyticsWriter(tx); return e.engine.changeAlertOwner(def.id, {}, e.sup.ctxOf(tenant), tx); }),
    (err) => err.code === 'ANALYTICS_ALERT_OWNER_REQUIRED'
  );
});
