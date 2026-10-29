'use strict';

// M9-D703 (Guia §6 e §16) — POST /analytics/alerts/:id/ack: OPEN -> ACKNOWLEDGED com autor e instante, idempotência, permissão, responsável,
// estado final, isolamento e o efeito (reconhecer não resolve, não muda cooldown e não cancela a tarefa). Banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const e = require('../_helpers/m9d703Env');

let env;
let tenant;
before(async () => { env = await e.setup(); tenant = env.tenantA; });
after(() => e.teardown(env));

const ack = (id, opts = {}) => env.call('POST', `/analytics/alerts/${id}/ack`, { perms: e.ACK, ...opts });
const row = async (id) => (await env.admin.query('SELECT * FROM analytics.alert_instances WHERE id = :id', { replacements: { id } }))[0][0];

test('m9d703 ack muda OPEN para ACKNOWLEDGED com autor e instante', async () => {
  const a = await e.openAlert(env, tenant, { severity: 'CRITICAL', createTask: true });
  env.events.length = 0;
  const before = Date.now();
  const res = await ack(a.instance.id, { user: a.member });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const item = res.body.data;
  assert.equal(item.id, a.instance.id);
  assert.equal(item.status, 'ACKNOWLEDGED');
  assert.equal(item.acknowledgedBy, a.member);
  assert.ok(Date.parse(item.acknowledgedAt) >= before - 1000 && Date.parse(item.acknowledgedAt) <= Date.now() + 1000);
  const db = await row(a.instance.id);
  assert.deepEqual([db.status, db.acknowledged_by], ['ACKNOWLEDGED', a.member]);
  assert.equal(db.acknowledged_at.toISOString(), new Date(item.acknowledgedAt).toISOString());
  const events = env.events.filter((x) => x.type === 'analytics.alert.acknowledged' && x.instanceId === a.instance.id);
  assert.equal(events.length, 1, 'analytics.alert.acknowledged pelo emitAlertEvent, depois do commit');
  assert.equal(events[0].acknowledgedBy, a.member);
  assert.ok(!('value' in events[0]) && !('lastValue' in events[0]));
});

test('m9d703 ack grava auditoria com antes e depois e o IP hasheado', async () => {
  const a = await e.openAlert(env, tenant);
  await ack(a.instance.id, { user: a.member });
  const [trail] = (await e.auditOf(env, tenant, 'analytics.alert.ack')).filter((r) => r.entity_id === a.instance.id);
  assert.ok(trail, 'auditoria do reconhecimento');
  assert.equal(trail.user_id, a.member);
  assert.deepEqual(trail.before_json, { status: 'OPEN', acknowledgedBy: null, acknowledgedAt: null });
  assert.equal(trail.after_json.status, 'ACKNOWLEDGED');
  assert.equal(trail.after_json.acknowledgedBy, a.member);
  assert.match(trail.after_json.ipHash, /^[0-9a-f]{64}$/, 'IP só como hash');
  assert.doesNotMatch(JSON.stringify(trail.after_json), /127\.0\.0\.1|::1/);
  assert.ok(trail.correlation_id, 'com correlation_id');
});

test('m9d703 ack repetido é idempotente e não troca quem reconheceu', async () => {
  const a = await e.openAlert(env, tenant, { extraMembers: 1 });
  const first = await ack(a.instance.id, { user: a.member });
  env.events.length = 0;
  const again = await ack(a.instance.id, { user: a.member });
  const other = await ack(a.instance.id, { user: a.others[0] });
  for (const res of [again, other]) {
    assert.equal(res.status, 200);
    assert.equal(res.body.data.status, 'ACKNOWLEDGED');
    assert.equal(res.body.data.acknowledgedBy, a.member, 'o autor original permanece');
    assert.equal(res.body.data.acknowledgedAt, first.body.data.acknowledgedAt);
  }
  assert.equal(env.events.filter((x) => x.type === 'analytics.alert.acknowledged').length, 0, 'sem novo evento');
  assert.equal((await e.auditOf(env, tenant, 'analytics.alert.ack')).filter((r) => r.entity_id === a.instance.id).length, 1, 'nem nova auditoria');
});

test('m9d703 usuário sem analytics:alert:ack é recusado com PERMISSION_DENIED', async () => {
  const a = await e.openAlert(env, tenant);
  const res = await ack(a.instance.id, { user: a.member, perms: e.READ });
  assert.equal(res.status, 403);
  assert.equal(res.body.error.code, 'PERMISSION_DENIED');
  assert.equal(res.body.error.message, 'Permissão ausente: analytics:alert:ack.');
  assert.equal((await row(a.instance.id)).status, 'OPEN');
});

test('m9d703 não-owner sem manage é recusado com ANALYTICS_ALERT_NOT_OWNER', async () => {
  const a = await e.openAlert(env, tenant);
  const stranger = await e.makeUser(env, tenant);
  const res = await ack(a.instance.id, { user: stranger });
  assert.equal(res.status, 403);
  assert.equal(res.body.error.code, 'ANALYTICS_ALERT_NOT_OWNER');
  assert.equal(res.body.error.message, 'Somente o responsável pelo alerta pode reconhecê-lo.');
  assert.equal((await row(a.instance.id)).status, 'OPEN');
  const manager = await ack(a.instance.id, { user: stranger, perms: [...e.ACK, 'analytics:alert:manage'] });
  assert.equal(manager.status, 200, 'com analytics:alert:manage qualquer um reconhece');
  assert.equal(manager.body.data.acknowledgedBy, stranger);
});

test('m9d703 owner por usuário reconhece e o reserva (owner inativo) também', async () => {
  const metric = await e.publish(env, tenant, { prefix: 'fin', criticality: 'CRITICAL' });
  const owner = await e.makeUser(env, tenant);
  const def = await e.defineForUser(env, tenant, metric, owner, {});
  await e.put(tenant, metric, { value: '5', at: e.at('15:00') });
  await e.evaluate(tenant, e.at('15:00'));
  const [instance] = await e.instances(env, tenant, def);
  const stranger = await e.makeUser(env, tenant);
  assert.equal((await ack(instance.id, { user: stranger })).body.error.code, 'ANALYTICS_ALERT_NOT_OWNER');
  assert.equal((await ack(instance.id, { user: owner })).status, 200);
  const reserve = await e.makeRole(env, tenant);
  const director = await e.makeUser(env, tenant, { role: reserve });
  await e.setSetting(env, tenant, 'analytics.alert.owner_reserva', reserve.name);
  const gone = await e.makeUser(env, tenant, { status: 'INACTIVE', membership: 'INACTIVE' });
  const m2 = await e.publish(env, tenant, { prefix: 'fin', criticality: 'CRITICAL' });
  const d2 = await e.defineForUser(env, tenant, m2, gone, {});
  await e.put(tenant, m2, { value: '5', at: e.at('15:10') });
  await e.evaluate(tenant, e.at('15:10'));
  const [i2] = await e.instances(env, tenant, d2);
  assert.equal((await ack(i2.id, { user: director })).status, 200, 'quem recebeu como reserva é o responsável');
  await env.admin.query("DELETE FROM core.tenant_settings WHERE company_id = :c AND key = 'analytics.alert.owner_reserva'", { replacements: { c: tenant.companyId } });
});

test('m9d703 ack em RESOLVED é recusado', async () => {
  const a = await e.openAlert(env, tenant, { autoResolve: { consecutiveOkEvaluations: 1 } });
  await a.step('10:30', '90000');
  assert.equal((await row(a.instance.id)).status, 'RESOLVED');
  const res = await ack(a.instance.id, { user: a.member });
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'ANALYTICS_ALERT_INVALID_TRANSITION');
  assert.equal(res.body.error.message, 'Transição de alerta inválida: RESOLVED -> ACKNOWLEDGED.');
  assert.equal((await row(a.instance.id)).acknowledged_by, null);
});

test('m9d703 alerta de outra empresa devolve 404', async () => {
  const a = await e.openAlert(env, tenant);
  const asB = await ack(a.instance.id, { tenant: 'B', user: env.tenantB.userId, perms: [...e.ACK, 'analytics:alert:manage'] });
  assert.equal(asB.status, 404);
  assert.equal(asB.body.error.code, 'ANALYTICS_ALERT_NOT_FOUND');
  assert.equal(asB.body.error.message, 'Alerta não encontrado.');
  assert.equal((await row(a.instance.id)).status, 'OPEN');
  for (const id of [e.uuid(), 'nao-e-uuid']) {
    const res = await ack(id, { user: a.member });
    assert.equal(res.status, 404, id);
    assert.equal(res.body.error.code, 'ANALYTICS_ALERT_NOT_FOUND');
  }
});

test('m9d703 alerta de domínio sem permissão responde 404 no ack', async () => {
  const a = await e.openAlert(env, tenant, { prefix: 'legal' });
  const res = await ack(a.instance.id, { user: a.member, perms: ['analytics:read', 'finance:read', 'analytics:alert:ack'] });
  assert.equal(res.status, 404);
  assert.equal(res.body.error.code, 'ANALYTICS_ALERT_NOT_FOUND');
});

test('m9d703 ack não cancela tarefa nem resolve', async () => {
  const a = await e.openAlert(env, tenant, { severity: 'CRITICAL', createTask: true, cooldownMinutes: 30 });
  assert.ok(a.instance.task_id);
  await ack(a.instance.id, { user: a.member });
  const db = await row(a.instance.id);
  assert.equal(db.status, 'ACKNOWLEDGED', 'reconhecido, não resolvido');
  assert.equal(db.resolved_at, null);
  assert.equal(db.cooldown_until, null, 'o cooldown não muda');
  assert.equal(db.task_id, a.instance.task_id);
  const task = (await e.tasksOf(env, tenant)).find((t) => t.id === a.instance.task_id);
  assert.equal(task.status, 'OPEN', 'a tarefa segue aberta');
  assert.equal(task.deleted_at, null);
  await a.step('10:20', '900'); // a condição continua: segue contando, sem novo alerta nem nova tarefa
  const [after1] = await e.instances(env, tenant, a.def);
  assert.equal(after1.status, 'ACKNOWLEDGED');
  assert.equal(after1.occurrence_count, 2);
  assert.equal((await e.instances(env, tenant, a.def)).length, 1);
  await a.step('10:30', '90000');
  await a.step('10:40', '90000'); // normaliza (2 avaliações): a normalização automática continua
  assert.equal((await row(a.instance.id)).status, 'RESOLVED');
});
