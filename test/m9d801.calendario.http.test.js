'use strict';

// M9-D801 — GET /calendar e compromissos avulsos pela API real (HTTP), em banco descartável (nunca o .env remoto):
//   node scripts/withDisposableDb.js --port <55000-55999> -- env CI_TENANT_USERS_PASSWORD=... bash -c \
//     "node scripts/seed-ci-two-tenants.js >/dev/null && NODE_ENV=test node --test --test-concurrency=1 test/m9d801.calendario.http.test.js"

process.env.PORT = process.env.M9D801_HTTP_TEST_PORT || '21651';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Sequelize } = require('sequelize');
const {
  DISPOSABLE, SKIP_DISPOSABLE, adminQuery, loadTenants, insertItem, cleanCalendar,
} = require('./m9d801.helpers');

let baseUrl;
let appLoaded = false;
let httpSkip = null;
let tenants;
let adminSequelize;
const tokens = {};

before(async () => {
  if (!DISPOSABLE) { httpSkip = SKIP_DISPOSABLE; return; }
  const password = process.env.CI_TENANT_USERS_PASSWORD;
  const { emailFor } = require('../scripts/seed-ci-two-tenants');
  const seeded = password ? (await adminQuery('SELECT 1 FROM core.users WHERE email = $1', [emailFor('A', 'gestor')])).rowCount : 0;
  if (!seeded) { httpSkip = 'seed de dois tenants ausente.'; return; }
  tenants = await loadTenants();
  adminSequelize = new Sequelize(process.env.DATABASE_ADMIN_URL, { dialect: 'postgres', logging: false });
  // calendar:read para GESTOR (legal:read, billing:read) e MAKER (legal:read, procurement:read) ANTES do login; LEITURA fica sem.
  await adminQuery(`INSERT INTO core.role_permissions (id, role_id, permission_id, created_at, updated_at)
    SELECT gen_random_uuid(), r.id, p.id, now(), now() FROM core.roles r CROSS JOIN core.permissions p
     WHERE r.name IN ('CI GESTOR', 'CI MAKER') AND p.code = 'governance:calendar:read'
       AND NOT EXISTS (SELECT 1 FROM core.role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = p.id)`);
  await adminQuery(`DELETE FROM core.role_permissions rp USING core.roles r, core.permissions p
     WHERE rp.role_id = r.id AND rp.permission_id = p.id AND r.name = 'CI LEITURA' AND p.code = 'governance:calendar:read'`);
  await cleanCalendar([tenants.A, tenants.B]);
  require('../app');
  appLoaded = true;
  baseUrl = `http://127.0.0.1:${process.env.PORT}/api/v1`;
  await new Promise((resolve) => setTimeout(resolve, 400));
  for (const [tenant, profile] of [['A', 'gestor'], ['A', 'maker'], ['A', 'leitura'], ['B', 'gestor']]) {
    let res; let body;
    for (let i = 0; i < 5; i += 1) {
      res = await fetch(`${baseUrl}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: emailFor(tenant, profile), password }) });
      body = await res.json();
      if (res.status !== 409) break;
      await new Promise((resolve) => setTimeout(resolve, 200 * (i + 1)));
    }
    assert.equal(res.status, 200, `login ${tenant}/${profile}`);
    tokens[`${tenant}:${profile}`] = body.data.accessToken;
  }
});

after(async () => {
  if (DISPOSABLE && tenants) await cleanCalendar([tenants.A, tenants.B]);
  if (adminSequelize) await adminSequelize.close().catch(() => {});
  if (appLoaded) {
    const { sequelize } = require('../src/models');
    await sequelize.close().catch(() => {});
    setTimeout(() => process.exit(0), 300);
  }
});

async function call(who, method, route, body) {
  const res = await fetch(`${baseUrl}${route}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(who ? { Authorization: `Bearer ${tokens[who]}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const W = 'from=2026-11-01&to=2026-11-30';

test('m9d801 sem permissão 403, from maior que to e sourceType desconhecido 400', async (t) => {
  if (httpSkip) return t.skip(httpSkip);
  const sem = await call('A:leitura', 'GET', '/calendar');
  assert.equal(sem.status, 403);
  assert.equal(sem.body.error.code, 'PERMISSION_DENIED');
  assert.equal(sem.body.error.details.required, 'governance:calendar:read');
  const range = await call('A:gestor', 'GET', '/calendar?from=2026-11-10&to=2026-11-01');
  assert.equal(range.status, 400);
  assert.equal(range.body.error.code, 'GOV_CALENDAR_RANGE_INVALID');
  assert.equal(range.body.error.message, 'A data inicial deve ser anterior à final.');
  const origem = await call('A:gestor', 'GET', '/calendar?sourceType=XPTO');
  assert.equal(origem.status, 400);
  assert.equal(origem.body.error.code, 'GOV_CALENDAR_SOURCE_INVALID');
  assert.equal(origem.body.error.message, 'Tipo de origem inválido.');
  assert.equal((await call('A:gestor', 'GET', '/calendar?pageSize=500')).body.error.code, 'GOV_VALIDATION_PAGINATION');
});

test('m9d801 não existe rota de escrita em calendar_items', async (t) => {
  if (httpSkip) return t.skip(httpSkip);
  const item = await insertItem(tenants.A, { sourceType: 'LEGAL_DEADLINE', title: 'QA-M9 intocável' });
  for (const method of ['PATCH', 'PUT', 'DELETE']) {
    const res = await call('A:gestor', method, `/calendar/items/${item.id}`, method === 'DELETE' ? undefined : { status: 'DONE' });
    assert.equal(res.status, 404, method);
    assert.equal(res.body.error.code, 'GOV_NOT_FOUND', method);
    assert.equal(res.body.error.message, 'Registro não encontrado.');
  }
  const { rows } = await adminQuery('SELECT status, title FROM governance.calendar_items WHERE id = $1', [item.id]);
  assert.deepEqual([rows[0].status, rows[0].title], ['OPEN', 'QA-M9 intocável']);
});

test('m9d801 listagem aplica filtros, ordenação, paginação e visibilidade por origem', async (t) => {
  if (httpSkip) return t.skip(httpSkip);
  await cleanCalendar([tenants.A]);
  const rows = [
    ['LEGAL_DEADLINE', '2026-11-03T15:00:00Z', 'OPEN'], ['BILLING', '2026-11-04T15:00:00Z', 'OPEN'], ['BILLING', '2026-11-05T15:00:00Z', 'DONE'],
    ['FISCAL', '2026-11-06T15:00:00Z', 'OPEN'], ['RENEWAL', '2026-11-07T15:00:00Z', 'OPEN'], ['BILLING', '2026-12-20T15:00:00Z', 'OPEN'],
  ];
  const ids = [];
  for (const [sourceType, dueAt, status] of rows) {
    ids.push((await insertItem(tenants.A, { sourceType, dueAt, status, title: `QA-M9 ${sourceType} ${dueAt}` })).id);
  }
  // Gestor lê jurídico e cobrança (e renovação, que aceita legal:read ou procurement:read), não fiscal: 4 itens na janela; o de dezembro fica fora.
  const todos = await call('A:gestor', 'GET', `/calendar?${W}`);
  assert.equal(todos.status, 200, JSON.stringify(todos.body));
  assert.deepEqual(todos.body.data.map((i) => i.sourceType), ['LEGAL_DEADLINE', 'BILLING', 'BILLING', 'RENEWAL']);
  assert.deepEqual(todos.body.pagination, { page: 1, pageSize: 50, total: 4, totalPages: 1 });
  assert.equal(todos.body.meta.timezone, 'America/Sao_Paulo');
  const item = todos.body.data[0];
  assert.deepEqual(Object.keys(item).sort(), ['cancelReason', 'deepLink', 'dueAt', 'endAt', 'id', 'isOverdue', 'ownerTeam', 'ownerUserId', 'severity', 'sourceId', 'sourceKind', 'sourceType', 'status', 'title']);
  const filtrado = await call('A:gestor', 'GET', `/calendar?${W}&sourceType=BILLING&status=OPEN`);
  assert.deepEqual(filtrado.body.data.map((i) => i.id), [ids[1]]);
  const proibido = await call('A:gestor', 'GET', `/calendar?${W}&sourceType=FISCAL`);
  assert.deepEqual([proibido.body.data.length, proibido.body.pagination.total], [0, 0]);
  const pag2 = await call('A:gestor', 'GET', `/calendar?${W}&pageSize=2&page=2`);
  assert.deepEqual(pag2.body.data.map((i) => i.id), [ids[2], ids[4]]);
  assert.deepEqual(pag2.body.pagination, { page: 2, pageSize: 2, total: 4, totalPages: 2 });
  // Maker lê jurídico e seguros (procurement:read), não cobrança.
  const maker = await call('A:maker', 'GET', `/calendar?${W}`);
  assert.deepEqual(maker.body.data.map((i) => i.sourceType), ['LEGAL_DEADLINE', 'RENEWAL']);
  // Janela padrão sem from/to: responde 200 com a janela em meta (hoje 00:00 SP + 30 dias).
  const padrao = await call('A:gestor', 'GET', '/calendar');
  assert.equal(padrao.status, 200);
  assert.match(padrao.body.meta.from, /T0[2-4]:00:00\.000Z$/);
  assert.match(padrao.body.meta.to, /T0[1-3]:59:59\.000Z$/);
  // Empresa B não vê nada da empresa A.
  assert.deepEqual((await call('B:gestor', 'GET', `/calendar?${W}`)).body.data, []);
});

test('m9d801 compromisso avulso: cria, gera item COMMITMENT, valida e respeita o dono', async (t) => {
  if (httpSkip) return t.skip(httpSkip);
  await cleanCalendar([tenants.A]);
  const body = { title: 'QA-M9 reunião com a diretoria', startsAt: '2026-11-10T13:00:00Z', endsAt: '2026-11-10T14:00:00Z' };
  const criado = await call('A:gestor', 'POST', '/calendar/commitments', body);
  assert.equal(criado.status, 201, JSON.stringify(criado.body));
  assert.equal(criado.body.data.status, 'OPEN');
  assert.equal(criado.body.data.ownerUserId, tenants.A.userId);
  const lista = await call('A:gestor', 'GET', `/calendar?${W}&sourceType=COMMITMENT`);
  assert.equal(lista.body.data.length, 1);
  const it = lista.body.data[0];
  assert.deepEqual([it.sourceType, it.sourceId, it.title, it.dueAt, it.endAt, it.ownerUserId], ['COMMITMENT', criado.body.data.id, body.title, '2026-11-10T13:00:00.000Z', '2026-11-10T14:00:00.000Z', tenants.A.userId]);
  assert.equal(it.deepLink, `/calendar/commitments/${criado.body.data.id}`);
  assert.equal(it.severity, 'INFO');

  const fim = await call('A:gestor', 'POST', '/calendar/commitments', { ...body, endsAt: '2026-11-10T12:00:00Z' });
  assert.equal(fim.status, 400);
  assert.equal(fim.body.error.code, 'GOV_COMMITMENT_INVALID');
  assert.equal(fim.body.error.message, 'O fim do compromisso deve ser após o início.');
  assert.equal((await call('A:gestor', 'POST', '/calendar/commitments', { startsAt: body.startsAt, endsAt: body.endsAt })).body.error.code, 'VALIDATION_ERROR');
  assert.equal((await call('A:leitura', 'POST', '/calendar/commitments', body)).status, 403);
  // Não administrador não cria em nome de outra pessoa; não altera compromisso alheio.
  const outroDono = await call('A:maker', 'POST', '/calendar/commitments', { ...body, ownerUserId: tenants.A.userId });
  assert.equal(outroDono.status, 403);
  assert.equal(outroDono.body.error.code, 'GOV_COMMITMENT_OWNER_ONLY');
  const alheio = await call('A:maker', 'PATCH', `/calendar/commitments/${criado.body.data.id}`, { title: 'QA-M9 invasão' });
  assert.equal(alheio.status, 403);
  assert.equal(alheio.body.error.code, 'GOV_COMMITMENT_OWNER_ONLY');
  assert.equal((await call('B:gestor', 'PATCH', `/calendar/commitments/${criado.body.data.id}`, { title: 'x' })).body.error.code, 'GOV_NOT_FOUND');
  assert.equal((await call('B:gestor', 'GET', `/calendar/commitments/${criado.body.data.id}`)).status, 404);

  // Dono altera: o item acompanha (mesma linha, versão sobe) e a auditoria guarda antes e depois.
  const edit = await call('A:gestor', 'PATCH', `/calendar/commitments/${criado.body.data.id}`, { title: 'QA-M9 reunião remarcada', startsAt: '2026-11-11T13:00:00Z', endsAt: '2026-11-11T14:30:00Z' });
  assert.equal(edit.status, 200, JSON.stringify(edit.body));
  const depois = (await call('A:gestor', 'GET', `/calendar?${W}&sourceType=COMMITMENT`)).body.data;
  assert.deepEqual([depois.length, depois[0].id, depois[0].title, depois[0].dueAt], [1, it.id, 'QA-M9 reunião remarcada', '2026-11-11T13:00:00.000Z']);
  const aud = await adminQuery("SELECT before_json, after_json FROM audit.audit_log WHERE entity_type = 'governance.calendar_commitment' AND entity_id = $1 ORDER BY occurred_at", [criado.body.data.id]);
  assert.equal(aud.rowCount, 2);
  assert.equal(aud.rows[1].before_json.title, 'QA-M9 reunião com a diretoria');
  assert.equal(aud.rows[1].after_json.title, 'QA-M9 reunião remarcada');

  // Status do compromisso: OPEN->DONE->OPEN->CANCELLED permitidos; CANCELLED->DONE não.
  const url = `/calendar/commitments/${criado.body.data.id}`;
  for (const status of ['DONE', 'OPEN', 'CANCELLED']) {
    assert.equal((await call('A:gestor', 'PATCH', url, { status })).status, 200, status);
  }
  const itemFinal = (await call('A:gestor', 'GET', `/calendar?${W}&sourceType=COMMITMENT&status=CANCELLED`)).body.data;
  assert.equal(itemFinal.length, 1);
  const invalida = await call('A:gestor', 'PATCH', url, { status: 'DONE' });
  assert.equal(invalida.status, 409);
  assert.equal(invalida.body.error.code, 'GOV_COMMITMENT_TRANSITION_INVALID');
});

test('m9d801 severidade e permissão por fonte configuradas pelo administrador valem de fato', async (t) => {
  if (httpSkip) return t.skip(httpSkip);
  await cleanCalendar([tenants.A]);
  const { upsertSetting } = require('../src/features/settings/settings.service');
  const { sequelize } = require('../src/models');
  const withTenant = (fn) => sequelize.transaction(async (tx) => {
    await sequelize.query("SELECT set_config('app.group_id', :g, true), set_config('app.company_id', :c, true), set_config('app.user_id', :u, true)", { replacements: { g: tenants.A.groupId, c: tenants.A.companyId, u: tenants.A.userId }, transaction: tx });
    return fn(tx);
  });
  await insertItem(tenants.A, { sourceType: 'BILLING', title: 'QA-M9 cobrança' });
  await withTenant((tx) => upsertSetting('governanca.calendario.severidade_por_fonte', 'COMMITMENT=CRITICAL', tenants.A, tenants.A.userId, tx));
  await withTenant((tx) => upsertSetting('governanca.calendario.permissao_por_fonte', 'BILLING=governance:calendar:read, COMMITMENT=governance:calendar:read', tenants.A, tenants.A.userId, tx));
  await withTenant((tx) => upsertSetting('governanca.calendario.janela_padrao_dias', 3, tenants.A, tenants.A.userId, tx));
  try {
    const criado = await call('A:gestor', 'POST', '/calendar/commitments', { title: 'QA-M9 crítico', startsAt: '2026-11-10T13:00:00Z', endsAt: '2026-11-10T14:00:00Z' });
    assert.equal(criado.status, 201);
    const maker = await call('A:maker', 'GET', `/calendar?${W}`);
    assert.deepEqual(maker.body.data.map((i) => i.sourceType).sort(), ['BILLING', 'COMMITMENT'], 'maker passou a ler cobrança pela permissão configurada');
    assert.equal(maker.body.data.find((i) => i.sourceType === 'COMMITMENT').severity, 'CRITICAL');
    const padrao = await call('A:gestor', 'GET', '/calendar');
    const dias = (new Date(padrao.body.meta.to) - new Date(padrao.body.meta.from)) / 86400000;
    assert.ok(dias > 3.9 && dias < 4.1, `janela de 3 dias a partir de hoje (4 dias corridos), veio ${dias}`);
  } finally {
    for (const key of ['severidade_por_fonte', 'permissao_por_fonte', 'janela_padrao_dias']) {
      await adminQuery("DELETE FROM core.tenant_settings WHERE key = $1 AND company_id = $2", [`governanca.calendario.${key}`, tenants.A.companyId]);
    }
  }
});
