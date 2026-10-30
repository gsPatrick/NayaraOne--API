'use strict';

// M9-D408 — aprovar e rejeitar (POST /marketing/content/:id/approve): hash gravado, motivo de 10 caracteres, concorrência com a edição, e a classe só muda com automation:manage.
process.env.PORT = process.env.M9D408_HTTP_TEST_PORT || '21708';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');
const { sequelize } = require('../../../src/models');
const { withTenantTransaction } = require('../../testHelpers');
const env = require('../_helpers/mktAutopublish');
const http = require('../_helpers/mktHttp');

const PREFIX = 'QA-M9 D408';
let ctx;
before(async () => {
  ctx = await env.setup();
  if (!http.DISPOSABLE) return;
  await http.start([
    { label: 'D408 redator', tenant: 'A', profile: 'gestor', permissions: ['marketing:content:read', 'marketing:content:write', 'settings:read', 'settings:update'] },
    { label: 'D408 aprovador', tenant: 'A', profile: 'leitura', permissions: ['marketing:content:read', 'marketing:content:approve', 'settings:read', 'settings:update'] },
    { label: 'D408 automacao', tenant: 'B', profile: 'gestor', permissions: ['marketing:automation:manage', 'settings:read', 'settings:update'] },
  ]);
});
after(async () => {
  await http.stop(PREFIX);
  await sequelize.close().catch(() => {});
  if (http.state.loaded) setTimeout(() => process.exit(0), 300);
});

const SKIP = !http.DISPOSABLE && http.SKIP_DISPOSABLE;
const create = (title) => http.call('D408 redator', 'POST', '/marketing/content', { type: 'INSTITUTIONAL', title: `${PREFIX} ${title}`, texto: 'Somos uma imobiliária de Salvador.' });

test('a_rota_aprova_grava_approved_hash_e_o_evento_com_autopublished_false', { skip: SKIP }, async () => {
  if (http.state.skip) return;
  const created = await create('aprovar');
  const id = created.body.data.id;
  const res = await http.call('D408 aprovador', 'POST', `/marketing/content/${id}/approve`, {});
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.match(res.body.data.approvedHash, /^[0-9a-f]{64}$/);
  const [version] = (await http.adminQuery('SELECT approved_hash, approved_by FROM marketing.content_versions WHERE content_item_id = $1', [id])).rows;
  assert.equal(version.approved_hash, res.body.data.approvedHash);
  const [event] = (await http.adminQuery("SELECT payload_json FROM integration.outbox_events WHERE aggregate_id = $1 AND event_type = 'marketing.content.approved'", [id])).rows;
  assert.equal(event.payload_json.payload.autopublished, false);
  const again = await http.call('D408 aprovador', 'POST', `/marketing/content/${id}/approve`, {});
  assert.equal(again.status, 409, 'aprovar de novo o que já está APPROVED');
  assert.equal(again.body.error.code, 'MKT_CONTENT_INVALID_TRANSITION');
});

test('rejeicao_exige_motivo_de_10_caracteres_e_devolve_a_draft', { skip: SKIP }, async () => {
  if (http.state.skip) return;
  const id = (await create('rejeitar')).body.data.id;
  const path = `/marketing/content/${id}/approve`;
  for (const body of [{ decision: 'REJECT' }, { decision: 'REJECT', reason: '' }, { decision: 'REJECT', reason: 'curto' }, { decision: 'REJECT', reason: '123456789' }]) {
    const res = await http.call('D408 aprovador', 'POST', path, body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(res.body.error.code, 'MKT_REASON_REQUIRED');
    assert.equal(res.body.error.message, 'Informe o motivo da rejeição (mínimo 10 caracteres).');
  }
  const ok = await http.call('D408 aprovador', 'POST', path, { decision: 'REJECT', reason: 'Texto fora do tom da marca.' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.data.status, 'DRAFT');
  const [row] = (await http.adminQuery('SELECT status FROM marketing.content_items WHERE id = $1', [id])).rows;
  assert.equal(row.status, 'DRAFT');
  const bad = await http.call('D408 aprovador', 'POST', path, { decision: 'TALVEZ' });
  assert.equal(bad.status, 400);
});

test('classe_so_e_alterada_com_automation_manage: content:approve sozinho = 403 MKT_FORBIDDEN; com automation:manage grava e audita', { skip: SKIP }, async () => {
  if (http.state.skip) return;
  const value = JSON.stringify([{ tipo: 'SOLD_RENTED', canal: 'SITE' }]);
  const key = 'marketing.autopublish.classes';
  const denied = await http.call('D408 aprovador', 'PUT', `/settings/${key}`, { value });
  assert.equal(denied.status, 403, JSON.stringify(denied.body));
  assert.equal(denied.body.error.code, 'MKT_FORBIDDEN');
  assert.equal(denied.body.error.details.required, 'marketing:automation:manage');
  const redator = await http.call('D408 redator', 'PUT', `/settings/${key}`, { value });
  assert.equal(redator.status, 403);
  const invalid = await http.call('D408 automacao', 'PUT', `/settings/${key}`, { value: '[{"tipo":"XYZ","canal":"SITE"}]' });
  assert.equal(invalid.status, 422, JSON.stringify(invalid.body));
  assert.equal(invalid.body.error.code, 'MKT_PARAM_INVALID');
  const ok = await http.call('D408 automacao', 'PUT', `/settings/${key}`, { value });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const audit = (await http.adminQuery("SELECT before_json, after_json FROM audit.audit_log WHERE entity_type = 'TenantSetting' AND after_json->>'key' = $1 ORDER BY occurred_at DESC LIMIT 1", [key])).rows[0];
  assert.ok(audit, 'a alteração da classe é auditada (antes e depois)');
  assert.equal(audit.after_json.value, value);
  await http.adminQuery("DELETE FROM core.tenant_settings WHERE key = $1", [key]).catch(() => null);
});

const DISPOSABLE = process.env.DISPOSABLE_DB === '1' && Boolean(process.env.DATABASE_ADMIN_URL);
test('aprovacao_e_edicao_simultaneas: a mudanca de fonte invalida (FACT_CHECK_FAILED) e a aprovacao que perde recebe 409; o item nunca termina APPROVED', { skip: !DISPOSABLE && 'precisa do banco descartável (COMMIT real)' }, async () => {
  const tx = (fn) => withTenantTransaction(ctx.tenant, fn);
  const created = [];
  try {
    for (let round = 0; round < 4; round += 1) {
      const item = await tx((t) => env.pendingInstitutional(t, ctx));
      created.push(item.itemId);
      const approve = () => tx((t) => env.service.approve({ tenant: ctx.tenant, actor: ctx.reviewer, itemId: item.itemId, input: {} }, t));
      const invalidate = () => tx((t) => env.service.changeStatus({ tenant: ctx.tenant, actor: ctx.tenant.userId, itemId: item.itemId, to: 'FACT_CHECK_FAILED', reason: 'Fonte alterada (teste).' }, t));
      const [a] = await Promise.allSettled(round % 2 === 0 ? [approve(), invalidate()] : [invalidate(), approve()].reverse());
      const [row] = await tx((t) => env.fx.q(t, 'SELECT status FROM marketing.content_items WHERE id = :i', { i: item.itemId }));
      assert.equal(row.status, 'FACT_CHECK_FAILED', 'a invalidação sempre prevalece no fim');
      if (a.status === 'rejected') assert.equal(a.reason.code, 'MKT_CONTENT_INVALID_TRANSITION', 'a aprovação que perdeu é 409');
    }
  } finally {
    const admin = new Client({ connectionString: process.env.DATABASE_ADMIN_URL });
    await admin.connect();
    try {
      await admin.query('UPDATE marketing.content_items SET current_version_id = NULL WHERE id = ANY($1)', [created]);
      await admin.query('DELETE FROM marketing.content_versions WHERE content_item_id = ANY($1)', [created]);
      await admin.query('DELETE FROM marketing.content_items WHERE id = ANY($1)', [created]);
    } finally { await admin.end(); }
  }
});
