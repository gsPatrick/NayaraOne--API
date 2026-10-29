'use strict';

// M9-D703 (Guia §6 e §16) — GET /analytics/alerts: filtros, ordenação por severidade, totais, ABAC por domínio e isolamento entre empresas.
// Router real de /analytics com autenticação simulada. Banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const e = require('../_helpers/m9d703Env');

let env;
let tenant;
before(async () => { env = await e.setup(); tenant = env.tenantA; });
after(() => e.teardown(env));

const list = (query = '', opts = {}) => env.call('GET', `/analytics/alerts${query}`, { perms: e.READ, ...opts });
const mine = (res, ids) => res.body.data.items.filter((i) => ids.includes(i.id));

test('m9d703 listagem ordena por severidade e filtra por status', async () => {
  const info = await e.openAlert(env, tenant, { severity: 'INFO', hhmm: '10:00' });
  const critical = await e.openAlert(env, tenant, { severity: 'CRITICAL', hhmm: '09:00' });
  const warning = await e.openAlert(env, tenant, { severity: 'WARNING', hhmm: '11:00' });
  const warningOlder = await e.openAlert(env, tenant, { severity: 'WARNING', hhmm: '08:00' });
  const ids = [info, critical, warning, warningOlder].map((a) => a.instance.id);
  const res = await list();
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const order = mine(res, ids).map((i) => i.id);
  assert.deepEqual(order, [critical.instance.id, warning.instance.id, warningOlder.instance.id, info.instance.id], 'CRITICAL primeiro e, no empate, opened_at decrescente');
  // padrão OPEN,ACKNOWLEDGED; RESOLVED só quando pedido
  await e.asWorker(env, "UPDATE analytics.alert_instances SET status = 'ACKNOWLEDGED', acknowledged_at = now(), acknowledged_by = :u WHERE id = :id", { u: tenant.userId, id: info.instance.id });
  await e.asWorker(env, "UPDATE analytics.alert_instances SET status = 'RESOLVED', resolved_at = now(), resolved_reason = 'CONDITION_NORMALIZED' WHERE id = :id", { id: warningOlder.instance.id });
  const def = (await list()).body.data.items.map((i) => i.id);
  assert.ok(def.includes(info.instance.id) && def.includes(critical.instance.id), 'OPEN e ACKNOWLEDGED aparecem');
  assert.ok(!def.includes(warningOlder.instance.id), 'alerta resolvido pelo engine sai da lista padrão');
  const resolved = await list('?status=RESOLVED');
  assert.ok(mine(resolved, ids).every((i) => i.status === 'RESOLVED') && mine(resolved, ids).length === 1);
  const onlyAck = await list('?status=ACKNOWLEDGED&severity=INFO');
  assert.deepEqual(mine(onlyAck, ids).map((i) => i.id), [info.instance.id]);
  const several = await list('?status=OPEN,RESOLVED');
  assert.ok(mine(several, ids).some((i) => i.status === 'RESOLVED') && mine(several, ids).some((i) => i.status === 'OPEN'));
});

test('m9d703 o item traz o contrato completo e o texto do valor', async () => {
  const a = await e.openAlert(env, tenant, { severity: 'CRITICAL', createTask: true, value: '42000.5' });
  const [item] = mine(await list(`?metricCode=${a.metric.code}`), [a.instance.id]);
  assert.deepEqual(Object.keys(item).sort(), ['acknowledgedAt', 'acknowledgedBy', 'alertCode', 'formattedLastValue', 'id', 'lastValue', 'link', 'metricCode', 'occurrenceCount', 'openedAt', 'owner', 'severity', 'status', 'taskId'].sort());
  assert.equal(item.alertCode, a.def.alert_code);
  assert.equal(item.metricCode, a.metric.code);
  assert.equal(item.severity, 'CRITICAL');
  assert.equal(item.status, 'OPEN');
  assert.equal(item.occurrenceCount, 1);
  assert.equal(item.lastValue, '42000.5');
  assert.equal(item.formattedLastValue, '42.000,5', 'unidade COUNT: separador de milhar e vírgula decimal, sem inventar casas');
  assert.deepEqual(item.owner, { userId: null, role: a.role.name });
  assert.equal(item.acknowledgedBy, null);
  assert.equal(item.acknowledgedAt, null);
  assert.equal(item.taskId, a.instance.task_id);
  assert.ok(item.taskId);
  assert.equal(item.link, `/painel/centro-de-comando?alerta=${a.instance.id}`);
  assert.equal(new Date(item.openedAt).toISOString(), a.instance.opened_at.toISOString());
});

test('m9d703 depois de 3 avaliações do mesmo problema a listagem mostra um único registro', async () => {
  const a = await e.openAlert(env, tenant, { hhmm: '10:00', value: '900' });
  await a.step('10:15', '800');
  await a.step('10:30', '700');
  const items = mine(await list(`?metricCode=${a.metric.code}`), [a.instance.id]);
  assert.equal(items.length, 1);
  assert.equal(items[0].occurrenceCount, 3);
  assert.equal(items[0].lastValue, '700');
  assert.equal((await list(`?metricCode=${a.metric.code}`)).body.data.items.length, 1, 'e é o único da métrica');
});

test('m9d703 filtros por métrica e severidade, totais e paginação', async () => {
  const x = await e.openAlert(env, tenant, { severity: 'CRITICAL' });
  const y = await e.openAlert(env, tenant, { severity: 'WARNING' });
  const res = await list(`?metricCode=${x.metric.code}`);
  assert.deepEqual(res.body.data.items.map((i) => i.id), [x.instance.id]);
  assert.deepEqual(res.body.data.totals, { total: 1, bySeverity: { CRITICAL: 1, WARNING: 0, INFO: 0 }, byStatus: { OPEN: 1, ACKNOWLEDGED: 0, RESOLVED: 0 } });
  const all = await list('?pageSize=1&page=1');
  assert.equal(all.body.data.items.length, 1);
  assert.equal(all.body.data.page, 1);
  assert.equal(all.body.data.pageSize, 1);
  assert.ok(all.body.data.totals.total >= 2, 'o total conta tudo, não só a página');
  assert.equal(all.body.data.items[0].severity, 'CRITICAL');
  const page2 = await list('?pageSize=1&page=2');
  assert.notEqual(page2.body.data.items[0].id, all.body.data.items[0].id);
  const crit = await list('?severity=CRITICAL');
  assert.ok(crit.body.data.items.every((i) => i.severity === 'CRITICAL') && crit.body.data.items.some((i) => i.id === x.instance.id) && !crit.body.data.items.some((i) => i.id === y.instance.id));
});

test('m9d703 parâmetros inválidos da consulta são 400 e pageSize passa de 100 é recusado', async () => {
  for (const q of ['?status=FECHADO', '?severity=ALTA', '?page=0', '?pageSize=0', '?pageSize=101', '?pageSize=abc', '?metricCode=NaoEhCodigo']) {
    const res = await list(q);
    assert.equal(res.status, 400, q);
    assert.equal(res.body.error.code, 'ANALYTICS_ALERT_QUERY_INVALID', q);
  }
  assert.equal((await list('?pageSize=100')).status, 200);
});

test('m9d703 alerta de domínio sem permissão não aparece na lista e o total não o conta', async () => {
  const fin = await e.openAlert(env, tenant, { prefix: 'fin', severity: 'CRITICAL' });
  const legal = await e.openAlert(env, tenant, { prefix: 'legal', severity: 'CRITICAL' });
  const onlyLegal = await env.call('GET', '/analytics/alerts?severity=CRITICAL', { perms: ['analytics:read', 'legal:read'] });
  const ids = onlyLegal.body.data.items.map((i) => i.id);
  assert.ok(ids.includes(legal.instance.id) && !ids.includes(fin.instance.id));
  const finOnly = (perms) => env.call('GET', `/analytics/alerts?metricCode=${fin.metric.code}`, { perms });
  assert.equal((await finOnly(e.READ)).body.data.totals.total, 1);
  assert.equal((await finOnly(['analytics:read', 'legal:read'])).body.data.totals.total, 0, 'o total do usuário sem Financeiro não conta o alerta do Financeiro');
  const none = await env.call('GET', `/analytics/alerts?metricCode=${fin.metric.code}`, { perms: ['analytics:read'] });
  assert.equal(none.status, 200);
  assert.deepEqual(none.body.data.items, []);
  assert.equal(none.body.data.totals.total, 0);
});

test('m9d703 sem analytics:read é PERMISSION_DENIED e empresa alheia é 404', async () => {
  const denied = await env.call('GET', '/analytics/alerts', { perms: [] });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error.code, 'PERMISSION_DENIED');
  const other = await list(`?companyId=${env.tenantB.companyId}`);
  assert.equal(other.status, 404);
  assert.equal(other.body.error.code, 'ANALYTICS_SCOPE_NOT_FOUND');
  assert.equal((await list(`?companyId=${tenant.companyId}`)).status, 200);
});

test('m9d703 a empresa B não enxerga os alertas da empresa A', async () => {
  const a = await e.openAlert(env, tenant, { severity: 'CRITICAL' });
  const asB = await env.call('GET', '/analytics/alerts?severity=CRITICAL&pageSize=100', { perms: e.READ, tenant: 'B' });
  assert.equal(asB.status, 200);
  assert.ok(!asB.body.data.items.some((i) => i.id === a.instance.id));
});

test('m9d703 a rota é somente leitura: POST na coleção não existe', async () => {
  const res = await env.call('POST', '/analytics/alerts', { perms: e.ACK, body: {} });
  assert.equal(res.status, 404);
});
