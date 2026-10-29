'use strict';

// M9-D701 (3.3) — exportação do DETALHE (drill-down) de um indicador pelo filtro assinado: todas as linhas-fonte, RESTRICTED mascarado, uma linha EXPORT_GENERATE no
// log de acesso e filtro adulterado recusado. Usa as origens de teste da M9-D690 (tabelas no schema analytics). Banco descartável com ClamAV (3310).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const env690 = require('../_helpers/m9d690Env');
const { runExportWorker } = require('../../../src/features/analytics/exports');
const diskStorage = require('../../../src/utils/diskStorage');

const BASE = ['analytics:read', 'analytics:export', 'analytics:drilldown'];
let env;
let restore;
let roleId;
before(async () => {
  env = await env690.setup();
  // o worker lê as permissões do BANCO: o usuário de seed ganha um papel de teste com as permissões do BI e as dos módulos de origem
  const t = env.tenantA;
  const codes = [...new Set([...BASE, ...env.metrics.map((m) => m.permission)])];
  const [[role]] = await env.admin.query(`INSERT INTO core.roles (id, group_id, company_id, name, description, created_at, updated_at) VALUES (gen_random_uuid(), :g, :c, :n, 'QA-M9 D701', now(), now()) RETURNING id`,
    { replacements: { g: t.groupId, c: t.companyId, n: `QA-M9 D701 ${env690.sfx()}` } });
  roleId = role.id;
  for (const code of codes) await env.admin.query('INSERT INTO core.role_permissions (id, role_id, permission_id, created_at, updated_at) SELECT gen_random_uuid(), :r, id, now(), now() FROM core.permissions WHERE code = :c', { replacements: { r: roleId, c: code } });
  const [[m]] = await env.admin.query('SELECT id, role_id FROM core.user_memberships WHERE user_id = :u AND company_id = :c', { replacements: { u: t.userId, c: t.companyId } });
  restore = m;
  await env.admin.query('UPDATE core.user_memberships SET role_id = :r WHERE id = :id', { replacements: { r: roleId, id: m.id } });
});
after(async () => {
  const t = env.tenantA;
  await env.admin.transaction(async (transaction) => {
    await env.admin.query("SET LOCAL session_replication_role = 'replica'", { transaction });
    const [files] = await env.admin.query("SELECT storage_key FROM people.files WHERE company_id = :c AND storage_key LIKE 'analytics-exports/%'", { replacements: { c: t.companyId }, transaction });
    for (const f of files) { try { diskStorage.deleteFile(f.storage_key); } catch (_e) { /* já apagado */ } }
    await env.admin.query("DELETE FROM people.files WHERE company_id = :c AND storage_key LIKE 'analytics-exports/%'", { replacements: { c: t.companyId }, transaction });
    await env.admin.query('DELETE FROM analytics.export_jobs WHERE company_id = :c', { replacements: { c: t.companyId }, transaction });
    await env.admin.query('DELETE FROM analytics.access_log WHERE company_id = :c', { replacements: { c: t.companyId }, transaction });
    await env.admin.query("DELETE FROM core.notifications WHERE company_id = :c AND title LIKE '%exportação%'", { replacements: { c: t.companyId }, transaction });
    await env.admin.query("DELETE FROM audit.audit_log WHERE company_id = :c AND action LIKE 'analytics.export.%'", { replacements: { c: t.companyId }, transaction });
    await env.admin.query("DELETE FROM integration.outbox_events WHERE company_id = :c AND event_type LIKE 'analytics.export.%'", { replacements: { c: t.companyId }, transaction });
    await env.admin.query('UPDATE core.user_memberships SET role_id = :r WHERE id = :id', { replacements: { r: restore.role_id, id: restore.id }, transaction });
    await env.admin.query('DELETE FROM core.role_permissions WHERE role_id = :r', { replacements: { r: roleId }, transaction });
    await env.admin.query('DELETE FROM core.roles WHERE id = :r', { replacements: { r: roleId }, transaction });
  });
  await env690.teardown(env);
});

const m = (key) => env.metrics.find((x) => x.key === key);
const permsOf = (metric) => [...BASE, metric.permission];
const scope = () => ({ groupId: env.tenantA.groupId, companyId: env.tenantA.companyId });
const drill = async (metric, mutate = (r) => r) => {
  const ref = mutate(await env690.refOf(env, metric));
  return { target: { drilldown: { metricCode: metric.code, filter: ref.filter, filterHash: ref.filterHash, filterSignature: ref.filterSignature } } };
};

test('m9d701 exportação do detalhe leva todas as linhas-fonte do filtro e mascara o RESTRICTED', async () => {
  const legal = m('legal');
  const res = await env.call('POST', '/analytics/exports', { perms: permsOf(legal), body: await drill(legal) });
  assert.equal(res.status, 202, JSON.stringify(res.body));
  const [out] = await runExportWorker(scope());
  assert.equal(out.status, 'READY', JSON.stringify(out));
  const [[job]] = await env.admin.query('SELECT * FROM analytics.export_jobs WHERE id = :id', { replacements: { id: res.body.data.jobId } });
  assert.equal(job.row_count, env690.INSIDE.length);
  assert.equal(job.scope.estimatedRows, env690.INSIDE.length);
  assert.ok(job.masked_fields.includes('cpf_titular'), JSON.stringify(job.masked_fields));
  const link = await env.call('GET', `/analytics/exports/${job.id}/download`, { perms: permsOf(legal) });
  assert.equal(link.status, 200, JSON.stringify(link.body));
  const file = await fetch(`http://127.0.0.1:${env.server.address().port}${link.body.data.url}`, { headers: { 'x-test-tenant': 'A', 'x-test-perms': permsOf(legal).join(',') } });
  assert.equal(file.status, 200);
  const text = await file.text();
  for (const raw of ['529.982.247-25', '52998224725', '111.444.777-35', '11144477735']) assert.ok(!text.includes(raw), `não deve vazar ${raw}`);
  assert.match(text, /\*\*\*\.982\.247-\*\*/);
  assert.match(text, /^# exportacao: DRILLDOWN legal\.m9d690_processos/);
  assert.equal(text.split('\r\n').filter((l) => l && !l.startsWith('#')).length, env690.INSIDE.length + 1, 'colunas mais uma linha por registro');
  const [log] = await env.admin.query("SELECT action, rows_returned, masking_applied FROM analytics.access_log WHERE resource_code = :id ORDER BY occurred_at", { replacements: { id: job.id } });
  assert.deepEqual(log.map((l) => [l.action, l.rows_returned, l.masking_applied]), [['EXPORT_REQUEST', env690.INSIDE.length, false], ['EXPORT_GENERATE', env690.INSIDE.length, true], ['EXPORT_DOWNLOAD', env690.INSIDE.length, false]]);
  const onDisk = (await env.admin.query('SELECT storage_key FROM people.files WHERE id = :id', { replacements: { id: job.file_id } }))[0][0].storage_key;
  assert.equal(fs.readFileSync(path.join(diskStorage.UPLOADS_ROOT, onDisk)).includes('529.982'), false, 'cifrado em repouso');
});

test('m9d701 detalhe: filtro adulterado, sem analytics:drilldown e indicador sem detalhe são recusados', async () => {
  const legal = m('legal');
  const forged = await env.call('POST', '/analytics/exports', { perms: permsOf(legal), body: await drill(legal, (r) => ({ ...r, filterHash: `${r.filterHash.slice(0, -1)}${r.filterHash.endsWith('0') ? '1' : '0'}` })) });
  assert.equal(forged.status, 400);
  assert.equal(forged.body.error.code, 'ANALYTICS_FILTER_HASH_INVALID');
  const semDetalhe = await env.call('POST', '/analytics/exports', { perms: ['analytics:read', 'analytics:export', legal.permission], body: await drill(legal) });
  assert.equal(semDetalhe.status, 403);
  const normal = m('prop');
  const notAvailable = await env.call('POST', '/analytics/exports', { perms: permsOf(normal), body: await drill(normal) });
  assert.equal(notAvailable.status, 409, 'indicador NORMAL sem detalhe habilitado');
  assert.equal(notAvailable.body.error.code, 'ANALYTICS_DRILLDOWN_NOT_AVAILABLE');
  const [[n]] = await env.admin.query("SELECT count(*)::int AS n FROM analytics.export_jobs WHERE metric_code IN (:c)", { replacements: { c: [legal.code, normal.code] } });
  assert.equal(n.n, 1, 'só o pedido válido do teste anterior existe');
});

test('m9d701 detalhe acima do teto de linhas é recusado no worker, sem truncar', async () => {
  await env.admin.query("INSERT INTO core.tenant_settings (id, group_id, company_id, key, value) VALUES (gen_random_uuid(), :g, :c, 'analytics.export.max_linhas', '2'::jsonb) ON CONFLICT (company_id, key) DO UPDATE SET value = EXCLUDED.value", { replacements: { g: env.tenantA.groupId, c: env.tenantA.companyId } });
  try {
    const fin = m('fin');
    const res = await env.call('POST', '/analytics/exports', { perms: permsOf(fin), body: await drill(fin) });
    assert.equal(res.status, 202);
    const [out] = await runExportWorker(scope());
    assert.deepEqual([out.status, out.errorCode], ['FAILED', 'ANALYTICS_EXPORT_TOO_LARGE']);
  } finally {
    await env.admin.query("DELETE FROM core.tenant_settings WHERE company_id = :c AND key = 'analytics.export.max_linhas'", { replacements: { c: env.tenantA.companyId } });
  }
});
