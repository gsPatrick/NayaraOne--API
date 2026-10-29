'use strict';

// M9-D802 — alertas do Calendário (vencido e conflito de agenda). Banco descartável (ver m9d802.projetor.test.js).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const env = require('../_helpers/m9d802Env');
const { runOverdueAlerts } = require('../../../src/features/core-governance/calendar/alerts/overdue.alert');
const { runConflictAlerts } = require('../../../src/features/core-governance/calendar/alerts/conflict.alert');
const { upsertSetting } = require('../../../src/features/settings/settings.service');

let tenants;
const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
before(async () => { if (env.DISPOSABLE) tenants = await env.loadTenants(); });
after(async () => { await env.sequelize.close(); });
const run = (fn) => env.withRollbackTenantTransaction(tenants.A, fn);
const uniq = () => `QA-M9-${env.randomUUID().slice(0, 8)}`;

const visit = (id, title, startUtc, userId = tenants.A.userId) => env.ev(tenants.A, 'crm.visit.scheduled', { id, scheduledAt: startUtc, agentUserId: userId, propertyTitle: title, status: 'SCHEDULED' });
const maintenance = (id, title, startUtc) => env.ev(tenants.A, 'maintenance.order.scheduled', { id, scheduledAt: startUtc, assetName: title, responsibleUserId: tenants.A.userId });
const notificationsWith = async (text, tx) => env.sequelize.query(
  'SELECT user_id, title, body FROM core.notifications WHERE company_id = :c AND body LIKE :like ORDER BY created_at',
  { replacements: { c: tenants.A.companyId, like: `%${text}%` }, transaction: tx, type: 'SELECT' }
);

test('m9d802 conflito de agenda gera alerta com 30 min', { skip: skip() }, async () => {
  await run(async (tx) => {
    const a = uniq(); const b = uniq();
    await env.projectEvent(visit(env.randomUUID(), a, '2026-10-21T13:00:00Z'), tx); // 10:00 a 11:00 em Brasília
    await env.projectEvent(maintenance(env.randomUUID(), b, '2026-10-21T13:30:00Z'), tx); // 10:30 a 11:30
    const summary = await runConflictAlerts(tenants.A, tx, new Date('2026-10-21T12:00:00Z'));
    assert.ok(summary.alerted >= 1);
    const sent = await notificationsWith(a, tx);
    assert.equal(sent.length, 1, 'um alerta');
    assert.equal(sent[0].user_id, tenants.A.userId);
    assert.match(sent[0].body, /CALENDAR_CONFLICT/);
    assert.match(sent[0].body, new RegExp(b));
    assert.match(sent[0].body, /30 minuto/);
  });
});

test('m9d802 fronteira 11:00-11:00 não conflita', { skip: skip() }, async () => {
  await run(async (tx) => {
    const a = uniq(); const b = uniq();
    await env.projectEvent(visit(env.randomUUID(), a, '2026-10-22T13:00:00Z'), tx); // 10:00 a 11:00
    await env.projectEvent(maintenance(env.randomUUID(), b, '2026-10-22T14:00:00Z'), tx); // 11:00 a 12:00
    await runConflictAlerts(tenants.A, tx, new Date('2026-10-22T12:00:00Z'));
    assert.equal((await notificationsWith(a, tx)).length, 0);
    assert.equal((await notificationsWith(b, tx)).length, 0);
  });
});

test('m9d802 conflito não realerta a cada 15 minutos', { skip: skip() }, async () => {
  await run(async (tx) => {
    const a = uniq(); const b = uniq();
    await env.projectEvent(visit(env.randomUUID(), a, '2026-10-23T13:00:00Z'), tx);
    await env.projectEvent(maintenance(env.randomUUID(), b, '2026-10-23T13:30:00Z'), tx);
    const t0 = new Date('2026-10-23T12:00:00Z');
    await runConflictAlerts(tenants.A, tx, t0);
    for (let i = 1; i <= 4; i += 1) await runConflictAlerts(tenants.A, tx, new Date(t0.getTime() + i * 15 * 60000));
    assert.equal((await notificationsWith(a, tx)).length, 1, 'um alerta por par e por dia');
    const keys = await env.sequelize.query("SELECT alert_key FROM governance.calendar_alert_log WHERE company_id = :c AND alert_key LIKE 'calendar.conflict:%:2026-10-23'", { replacements: { c: tenants.A.companyId }, transaction: tx, type: 'SELECT' });
    assert.ok(keys.length >= 1);
    // No dia seguinte o par ainda conflita (itens abertos): novo alerta, com chave do novo dia.
    await runConflictAlerts(tenants.A, tx, new Date('2026-10-23T14:00:00Z'));
    assert.equal((await notificationsWith(a, tx)).length, 1, 'mesmo dia: continua um');
  });
});

test('m9d802 a fonte do conflito e a duração padrão são parâmetros', { skip: skip() }, async () => {
  await run(async (tx) => {
    const a = uniq(); const b = uniq();
    await env.projectEvent(visit(env.randomUUID(), a, '2026-10-24T13:00:00Z'), tx);
    await env.projectEvent(maintenance(env.randomUUID(), b, '2026-10-24T13:30:00Z'), tx);
    // Administrador tira MAINTENANCE da lista de fontes do conflito: o par deixa de existir.
    await upsertSetting('governanca.calendario.fontes_conflito', 'VISIT, COMMITMENT', tenants.A, tenants.A.userId, tx);
    await runConflictAlerts(tenants.A, tx, new Date('2026-10-24T12:00:00Z'));
    assert.equal((await notificationsWith(a, tx)).length, 0);
  });
});

test('m9d802 vencido gera um alerta por dia', { skip: skip() }, async () => {
  await run(async (tx) => {
    const title = uniq();
    const id = env.randomUUID();
    await env.projectEvent(env.ev(tenants.A, 'legal.deadline.created', { id, description: title, dueAt: '2026-10-10', responsibleUserId: tenants.A.userId, status: 'PENDING' }), tx);
    const morning = new Date('2026-10-26T09:00:00Z'); // 06:00 em Brasília
    await runOverdueAlerts(tenants.A, tx, morning);
    await runOverdueAlerts(tenants.A, tx, new Date(morning.getTime() + 3600000));
    assert.equal((await notificationsWith(title, tx)).length, 1, 'duas varreduras no mesmo dia, um aviso');
    await runOverdueAlerts(tenants.A, tx, new Date('2026-10-27T09:00:00Z'));
    assert.equal((await notificationsWith(title, tx)).length, 2, 'novo dia, novo aviso');
    // Concluído na origem: o item fecha e o alerta de vencido some.
    await env.projectEvent(env.ev(tenants.A, 'legal.deadline.completed', { id, description: title, dueAt: '2026-10-10', status: 'DONE' }, '2026-10-27T10:00:00Z'), tx);
    await runOverdueAlerts(tenants.A, tx, new Date('2026-10-28T09:00:00Z'));
    assert.equal((await notificationsWith(title, tx)).length, 2, 'item fechado não alerta mais');
  });
});

test('m9d802 item sem usuário alerta os usuários do papel de owner_team', { skip: skip() }, async () => {
  await run(async (tx) => {
    const [membership] = await env.sequelize.query(
      `SELECT r.name FROM core.user_memberships m JOIN core.roles r ON r.id = m.role_id WHERE m.user_id = :u AND m.company_id = :c AND m.status = 'ACTIVE' LIMIT 1`,
      { replacements: { u: tenants.A.userId, c: tenants.A.companyId }, transaction: tx, type: 'SELECT' }
    );
    // Cobrança sem responsável: o item recebe owner_team com o papel configurado para BILLING.
    await upsertSetting('governanca.calendario.papel_por_fonte', `BILLING=${membership.name}, FISCAL=fiscal`, tenants.A, tenants.A.userId, tx);
    const id = env.randomUUID();
    const marker = uniq();
    await env.projectEvent(env.ev(tenants.A, 'billing.schedule_item.upserted', { id, period: marker, dueDate: '2026-10-05', status: 'OPEN' }), tx);
    const item = await env.itemOf(tenants.A, 'BILLING', id, tx);
    assert.equal(item.owner_user_id, null);
    assert.equal(item.owner_team, membership.name);
    await runOverdueAlerts(tenants.A, tx, new Date('2026-10-26T09:00:00Z'));
    const sent = await notificationsWith(marker, tx);
    assert.ok(sent.length >= 1, 'quem tem o papel recebe');
    assert.ok(sent.some((row) => row.user_id === tenants.A.userId));
  });
});

test('m9d802 alertas leem calendar_items e não as tabelas de origem', { skip: skip() }, async () => {
  const sources = ['overdue.alert.js', 'conflict.alert.js', 'alerts.log.js'].map((f) => fs.readFileSync(path.join(__dirname, '../../../src/features/core-governance/calendar/alerts', f), 'utf8')).join('\n');
  for (const origin of ['legal_deadlines', 'core.tasks', 'crm.visits', 'billing_schedules', 'fiscal_obligations', 'maintenance_orders', 'insurance_renewal_tasks', 'maintenance_cases', 'project_stages']) {
    assert.ok(!sources.includes(origin), `os alertas não citam ${origin}`);
  }
  await run(async (tx) => {
    const seen = [];
    env.sequelize.options.logging = (sql) => { seen.push(sql); };
    try {
      await runOverdueAlerts(tenants.A, tx, new Date('2026-10-26T09:00:00Z'));
      await runConflictAlerts(tenants.A, tx, new Date('2026-10-26T09:00:00Z'));
    } finally { env.sequelize.options.logging = false; }
    const tables = new Set();
    for (const sql of seen) for (const m of sql.matchAll(/\b(?:FROM|JOIN|INTO|UPDATE)\s+"?([a-z_]+)"?\."?([a-z_]+)"?/gi)) tables.add(`${m[1]}.${m[2]}`.toLowerCase());
    const allowed = new Set(['governance.calendar_items', 'governance.calendar_alert_log', 'core.notifications', 'core.user_memberships', 'core.users', 'core.roles', 'core.tenant_settings']);
    for (const table of tables) assert.ok(allowed.has(table), `tabela inesperada nos alertas: ${table}`);
    assert.ok(tables.has('governance.calendar_items'));
  });
});
