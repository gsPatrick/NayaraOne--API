'use strict';

// M9-D801 — Calendário unificado: regras puras (janela em America/Sao_Paulo, filtros, mapas configuráveis, permissão do
// compromisso) e regras com banco (UNIQUE por origem, isOverdue derivado, visibilidade por origem, 10 fontes, isolamento).
// Rodar em banco descartável:
//   node scripts/withDisposableDb.js --port <55000-55999> -- env CI_TENANT_USERS_PASSWORD=... bash -c \
//     "node scripts/seed-ci-two-tenants.js >/dev/null && NODE_ENV=test node --test --test-concurrency=1 test/m9d801.calendario.regras.test.js"

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../src/models');
const {
  DISPOSABLE, SKIP_DISPOSABLE, adminQuery, loadTenants, insertItem, cleanCalendar,
} = require('./m9d801.helpers');

const NOW = new Date('2026-10-27T12:00:00Z'); // 27/10/2026 09:00 em America/Sao_Paulo
const CAL = '../src/features/core-governance/calendar';
let tenants;

before(async () => {
  if (!DISPOSABLE) return;
  tenants = await loadTenants();
  await cleanCalendar([tenants.A, tenants.B]);
});

after(async () => {
  if (DISPOSABLE) await cleanCalendar([tenants.A, tenants.B]);
  await sequelize.close();
});

function withTenant(tenant, fn) {
  return sequelize.transaction(async (transaction) => {
    await sequelize.query("SELECT set_config('app.group_id', :g, true), set_config('app.company_id', :c, true), set_config('app.user_id', :u, true)", {
      replacements: { g: tenant.groupId, c: tenant.companyId, u: tenant.userId }, transaction,
    });
    return fn(transaction);
  });
}

const ALL_PERMISSIONS = ['governance:calendar:read', 'crm:tasks:read', 'crm:visits:read', 'legal:read', 'procurement:read', 'billing:read', 'construction:read', 'correspondent:fiscal'];

test('m9d801 janela padrão 30 dias em America/Sao_Paulo', () => {
  const { defaultWindow } = require(`${CAL}/calendar.window`);
  const w = defaultWindow(NOW, 30);
  assert.equal(w.from.toISOString(), '2026-10-27T03:00:00.000Z', 'hoje 00:00 em São Paulo');
  assert.equal(w.to.toISOString(), '2026-11-27T02:59:59.000Z', '26/11 23:59:59 em São Paulo');
  // 23:00 de 27/10 em São Paulo já é 28/10 02:00 em UTC: o "hoje" continua sendo 27/10.
  const noite = defaultWindow(new Date('2026-10-28T02:00:00Z'), 30);
  assert.equal(noite.from.toISOString(), '2026-10-27T03:00:00.000Z');
  // O número de dias vem do parâmetro, não de uma constante.
  assert.equal(defaultWindow(NOW, 7).to.toISOString(), '2026-11-04T02:59:59.000Z');
});

test('m9d801 from maior que to e sourceType desconhecido devolvem 400', () => {
  const { parseListQuery } = require(`${CAL}/calendar.query`);
  const opts = { now: NOW, windowDays: 30, defaultPageSize: 50 };
  assert.throws(() => parseListQuery({ from: '2026-11-10', to: '2026-11-01' }, opts), (e) => e.statusCode === 400 && e.code === 'GOV_CALENDAR_RANGE_INVALID' && e.message === 'A data inicial deve ser anterior à final.');
  assert.throws(() => parseListQuery({ sourceType: 'CRM_TASK,XPTO' }, opts), (e) => e.statusCode === 400 && e.code === 'GOV_CALENDAR_SOURCE_INVALID' && e.message === 'Tipo de origem inválido.');
  assert.throws(() => parseListQuery({ pageSize: '201' }, opts), (e) => e.statusCode === 400 && e.code === 'VALIDATION_ERROR');
  assert.throws(() => parseListQuery({ pageSize: '0' }, opts), (e) => e.code === 'VALIDATION_ERROR');
  assert.throws(() => parseListQuery({ status: 'LATE' }, opts), (e) => e.code === 'VALIDATION_ERROR');
  assert.throws(() => parseListQuery({ ownerUserId: 'nao-e-uuid' }, opts), (e) => e.code === 'VALIDATION_ERROR');
  assert.throws(() => parseListQuery({ from: 'ontem' }, opts), (e) => e.code === 'VALIDATION_ERROR');
  const ok = parseListQuery({ sourceType: ['FISCAL', 'BILLING,VISIT'], status: 'OPEN', page: '2', pageSize: '10' }, opts);
  assert.deepEqual(ok.sourceTypes, ['FISCAL', 'BILLING', 'VISIT']);
  assert.deepEqual([ok.statuses, ok.page, ok.pageSize], [['OPEN'], 2, 10]);
  const padrao = parseListQuery({}, opts);
  assert.equal(padrao.pageSize, 50);
  assert.equal(padrao.from.toISOString(), '2026-10-27T03:00:00.000Z');
  // Data sem hora vale o dia inteiro em São Paulo.
  const dia = parseListQuery({ from: '2026-11-01', to: '2026-11-01' }, opts);
  assert.equal(dia.from.toISOString(), '2026-11-01T03:00:00.000Z');
  assert.equal(dia.to.toISOString(), '2026-11-02T02:59:59.000Z');
});

test('m9d801 severidade e permissão por fonte vêm dos parâmetros do administrador', () => {
  const settings = require(`${CAL}/calendar.settings`);
  const { severityFor } = require(`${CAL}/calendar.severity`);
  const { allowedSourceTypes } = require(`${CAL}/calendar.visibility`);
  const sev = settings.parseSeverityMap(settings.CALENDAR_SETTING_DEFAULTS['governanca.calendario.severidade_por_fonte']);
  assert.equal(severityFor('LEGAL_DEADLINE', sev), 'CRITICAL');
  assert.equal(severityFor('FISCAL', sev), 'CRITICAL');
  assert.equal(severityFor('BILLING', sev), 'WARNING');
  assert.equal(severityFor('GUARANTEE', sev), 'WARNING');
  assert.equal(severityFor('VISIT', sev), 'INFO');
  const custom = settings.parseSeverityMap('VISIT=CRITICAL, BILLING=lixo, XPTO=WARNING');
  assert.equal(severityFor('VISIT', custom), 'CRITICAL');
  assert.equal(severityFor('BILLING', custom), 'INFO', 'valor inválido volta ao nível INFO');
  const { SETTINGS_SCHEMA } = require('../src/features/settings/settings.service');
  const sevSpec = SETTINGS_SCHEMA[settings.SEVERITY_KEY];
  assert.doesNotThrow(() => sevSpec.validate(settings.SEVERITY_KEY, 'VISIT=CRITICAL, FISCAL=info'));
  for (const ruim of ['XPTO=INFO', 'VISIT=URGENTE', 'VISIT']) assert.throws(() => sevSpec.validate(settings.SEVERITY_KEY, ruim), (e) => e.code === 'VALIDATION_ERROR', ruim);
  assert.equal(SETTINGS_SCHEMA[settings.WINDOW_DAYS_KEY].type, 'integer');
  const perm = settings.parsePermissionMap(settings.CALENDAR_SETTING_DEFAULTS['governanca.calendario.permissao_por_fonte']);
  assert.deepEqual(allowedSourceTypes(['legal:read'], perm).sort(), ['GUARANTEE', 'LEGAL_DEADLINE', 'RENEWAL']);
  assert.deepEqual(allowedSourceTypes(['governance:calendar:read'], perm), ['COMMITMENT']);
  assert.deepEqual(allowedSourceTypes([], perm), []);
  assert.deepEqual(allowedSourceTypes(['legal:read'], settings.parsePermissionMap('')).sort(), ['GUARANTEE', 'LEGAL_DEADLINE', 'RENEWAL'], 'texto vazio volta ao padrão');
  assert.deepEqual(allowedSourceTypes(['legal:read'], settings.parsePermissionMap('FISCAL=correspondent:fiscal')), [], 'fonte sem mapeamento fica fechada');
});

test('m9d801 só o dono do compromisso ou o administrador gerencia', () => {
  const { canManageCommitment } = require(`${CAL}/calendar.permissions`);
  assert.equal(canManageCommitment({ userId: 'u1', roles: ['CORRETOR'] }, { ownerUserId: 'u1' }), true);
  assert.equal(canManageCommitment({ userId: 'u2', roles: ['CORRETOR'] }, { ownerUserId: 'u1' }), false);
  assert.equal(canManageCommitment({ userId: 'u2', roles: ['ADMIN'] }, { ownerUserId: 'u1' }), true);
});

test('m9d801 unique por fonte impede duplicata', async (t) => {
  if (!DISPOSABLE) return t.skip(SKIP_DISPOSABLE);
  const first = await insertItem(tenants.A, { sourceType: 'LEGAL_DEADLINE' });
  await assert.rejects(() => insertItem(tenants.A, { sourceType: 'LEGAL_DEADLINE', sourceId: first.sourceId }), (e) => e.code === '23505' && /gov_cal_items_source_uq/.test(e.constraint));
  // Mesma origem em outra empresa é outra linha (o UNIQUE inclui company_id).
  await insertItem(tenants.B, { sourceType: 'LEGAL_DEADLINE', sourceId: first.sourceId });
  const upsert = require(`${CAL}/calendar.projection.store`);
  const again = await withTenant(tenants.A, (tx) => upsert.upsertItem(tenants.A, {
    sourceType: 'LEGAL_DEADLINE', sourceId: first.sourceId, title: 'QA-M9 reentrega', dueAt: '2026-11-06T02:59:59Z', deepLink: '/painel/juridico/prazos/x', severity: 'CRITICAL',
  }, tx));
  assert.equal(again.id, first.id, 'o upsert reaproveita a linha da origem');
  const { rows } = await adminQuery('SELECT count(*)::int AS n, max(projection_version) AS v FROM governance.calendar_items WHERE company_id = $1 AND source_id = $2', [tenants.A.companyId, first.sourceId]);
  assert.deepEqual([rows[0].n, rows[0].v], [1, 2]);
});

test('m9d801 isOverdue derivado e não gravado', async (t) => {
  if (!DISPOSABLE) return t.skip(SKIP_DISPOSABLE);
  const { rows } = await adminQuery("SELECT column_name FROM information_schema.columns WHERE table_schema='governance' AND table_name='calendar_items'");
  assert.ok(!rows.some((r) => /overdue|vencid/i.test(r.column_name)), 'não existe coluna de vencido');
  assert.ok(!rows.some((r) => r.column_name === 'is_overdue'));
  const aberto = await insertItem(tenants.A, { title: 'QA-M9 vencido', dueAt: '2026-10-26T21:00:00Z', severity: 'WARNING' });
  const feito = await insertItem(tenants.A, { title: 'QA-M9 feito', dueAt: '2026-10-26T21:00:00Z', status: 'DONE' });
  const futuro = await insertItem(tenants.A, { title: 'QA-M9 futuro', dueAt: '2026-11-20T21:00:00Z' });
  const { listCalendar } = require(`${CAL}/calendar.service`);
  const res = await withTenant(tenants.A, (tx) => listCalendar(tenants.A, {
    permissions: ALL_PERMISSIONS, query: { from: '2026-10-01', to: '2026-12-31', sourceType: 'CRM_TASK' }, now: NOW,
  }, tx));
  const byId = Object.fromEntries(res.items.map((i) => [i.id, i]));
  assert.equal(byId[aberto.id].isOverdue, true);
  assert.equal(byId[aberto.id].severity, 'WARNING', 'a severidade não muda por estar vencido');
  assert.equal(byId[aberto.id].status, 'OPEN', 'vencido não é status');
  assert.equal(byId[feito.id].isOverdue, false);
  assert.equal(byId[futuro.id].isOverdue, false);
});

test('m9d801 item cuja origem o usuário não lê é omitido', async (t) => {
  if (!DISPOSABLE) return t.skip(SKIP_DISPOSABLE);
  await cleanCalendar([tenants.A]);
  for (const sourceType of ['LEGAL_DEADLINE', 'FISCAL', 'BILLING', 'COMMITMENT']) {
    await insertItem(tenants.A, { sourceType, title: `QA-M9 ${sourceType}` });
  }
  const { listCalendar } = require(`${CAL}/calendar.service`);
  const run = (permissions) => withTenant(tenants.A, (tx) => listCalendar(tenants.A, { permissions, query: { from: '2026-11-01', to: '2026-11-30' }, now: NOW }, tx));
  const juridico = await run(['governance:calendar:read', 'legal:read']);
  assert.deepEqual(juridico.items.map((i) => i.sourceType).sort(), ['COMMITMENT', 'LEGAL_DEADLINE']);
  assert.equal(juridico.pagination.total, 2, 'o total reflete a omissão');
  const fiscal = await run(['governance:calendar:read', 'correspondent:fiscal', 'billing:read']);
  assert.deepEqual(fiscal.items.map((i) => i.sourceType).sort(), ['BILLING', 'COMMITMENT', 'FISCAL']);
  // Pedir explicitamente uma origem proibida não vaza: resultado vazio.
  const pedido = await withTenant(tenants.A, (tx) => listCalendar(tenants.A, { permissions: ['governance:calendar:read'], query: { from: '2026-11-01', to: '2026-11-30', sourceType: 'FISCAL' }, now: NOW }, tx));
  assert.equal(pedido.items.length, 0);
  assert.equal(pedido.pagination.total, 0);
});

test('m9d801 as 10 fontes do livro aparecem com deep_link válido', async (t) => {
  if (!DISPOSABLE) return t.skip(SKIP_DISPOSABLE);
  await cleanCalendar([tenants.A]);
  const links = {
    CRM_TASK: '/painel/crm/tarefas/1', VISIT: '/painel/crm/visitas/1', LEGAL_DEADLINE: '/painel/juridico/prazos/1', RENEWAL: '/painel/seguros/renovacoes/1',
    GUARANTEE: '/painel/juridico/contratos/1', BILLING: '/painel/financeiro/cobrancas/1', CONSTRUCTION: '/painel/obras/1/etapas/2',
    MAINTENANCE: '/painel/obras/pos-obra/ordens/1', FISCAL: '/painel/correspondente/fiscal/1', COMMITMENT: '/calendar/commitments/1',
  };
  for (const [sourceType, deepLink] of Object.entries(links)) {
    await insertItem(tenants.A, { sourceType, deepLink, title: `QA-M9 ${sourceType}` });
  }
  const { listCalendar } = require(`${CAL}/calendar.service`);
  const { isValidDeepLink } = require(`${CAL}/calendar.deeplinks`);
  const res = await withTenant(tenants.A, (tx) => listCalendar(tenants.A, { permissions: ALL_PERMISSIONS, query: { from: '2026-11-01', to: '2026-11-30' }, now: NOW }, tx));
  assert.equal(res.items.length, 10);
  assert.deepEqual(res.items.map((i) => i.sourceType).sort(), Object.keys(links).sort());
  for (const item of res.items) assert.equal(isValidDeepLink(item.deepLink), true, item.deepLink);
  for (const ruim of ['http://x.com/a', '//x.com', 'painel/x', '/painel/ x', 'javascript:alert(1)', '']) assert.equal(isValidDeepLink(ruim), false, ruim);
  await assert.rejects(() => insertItem(tenants.A, { deepLink: 'http://externo.com/x' }), /gov_cal_items_deep_link_chk/);
  await assert.rejects(() => insertItem(tenants.A, { sourceType: 'OUTRA' }), /gov_cal_items_source_type_chk/);
});

test('m9d801 isolamento entre empresas', async (t) => {
  if (!DISPOSABLE) return t.skip(SKIP_DISPOSABLE);
  await cleanCalendar([tenants.A, tenants.B]);
  await insertItem(tenants.A, { title: 'QA-M9 da empresa A' });
  await insertItem(tenants.B, { title: 'QA-M9 da empresa B' });
  const { listCalendar } = require(`${CAL}/calendar.service`);
  const q = { from: '2026-11-01', to: '2026-11-30' };
  const a = await withTenant(tenants.A, (tx) => listCalendar(tenants.A, { permissions: ALL_PERMISSIONS, query: q, now: NOW }, tx));
  const b = await withTenant(tenants.B, (tx) => listCalendar(tenants.B, { permissions: ALL_PERMISSIONS, query: q, now: NOW }, tx));
  assert.deepEqual(a.items.map((i) => i.title), ['QA-M9 da empresa A']);
  assert.deepEqual(b.items.map((i) => i.title), ['QA-M9 da empresa B']);
  // RLS no banco: mesmo sem filtro de empresa na consulta, a sessão de A não enxerga B nem grava como B.
  const [rows] = await withTenant(tenants.A, (tx) => sequelize.query('SELECT title FROM governance.calendar_items', { transaction: tx }));
  assert.deepEqual(rows.map((r) => r.title), ['QA-M9 da empresa A']);
  await assert.rejects(() => withTenant(tenants.A, (tx) => sequelize.query(
    `INSERT INTO governance.calendar_items (group_id, company_id, source_type, source_id, title, due_at, deep_link) VALUES (:g, :c, 'CRM_TASK', gen_random_uuid(), 'x', now(), '/x')`,
    { replacements: { g: tenants.B.groupId, c: tenants.B.companyId }, transaction: tx }
  )), /row-level security/);
});

test('m9d801 migration é reversível e as tabelas têm RLS forçado', async (t) => {
  if (!DISPOSABLE) return t.skip(SKIP_DISPOSABLE);
  const { Sequelize } = require('sequelize');
  const admin = new Sequelize(process.env.DATABASE_ADMIN_URL, { dialect: 'postgres', logging: false });
  const migration = require('../migrations/20260101000801-create-governance-calendar');
  const exists = async () => (await adminQuery("SELECT table_name FROM information_schema.tables WHERE table_schema='governance' AND table_name IN ('calendar_items','calendar_commitments') ORDER BY 1")).rows.map((r) => r.table_name);
  try {
    await migration.down(admin.getQueryInterface());
    assert.deepEqual(await exists(), []);
    await migration.up(admin.getQueryInterface());
    await migration.up(admin.getQueryInterface()); // idempotente
    assert.deepEqual(await exists(), ['calendar_commitments', 'calendar_items']);
    const { rows: rls } = await adminQuery("SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname='governance' AND relname IN ('calendar_items','calendar_commitments')");
    assert.equal(rls.length, 2);
    for (const r of rls) assert.deepEqual([r.relrowsecurity, r.relforcerowsecurity], [true, true], r.relname);
  } finally {
    await admin.close();
  }
});
