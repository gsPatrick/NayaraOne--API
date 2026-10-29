'use strict';

// M9-D701 (3.4) — download: só o solicitante, endereço assinado curto, expiração com limpeza do arquivo, isolamento entre empresas e job preso.
// Banco descartável com ClamAV (3310).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const e = require('../_helpers/m9d701Env');
const diskStorage = require('../../../src/utils/diskStorage');
const { runExportCleanup } = require('../../../src/features/analytics/exports');

let env;
let metric;
before(async () => {
  env = await e.setup();
  metric = await e.metricWithSeries(env, { series: 2 });
});
after(() => e.teardown(env));

const target = () => ({ target: { metricCode: metric.code }, period: e.TODAY });
const code = (res) => res.body && res.body.error && res.body.error.code;
const linkOf = (id, opts) => env.http('GET', `/analytics/exports/${id}/download`, opts);

test('m9d701 download por outro usuário com analytics:export é recusado', async () => {
  e.at(e.NOW);
  const { id } = await e.requestAndRun(env, target());
  const mine = await linkOf(id);
  assert.equal(mine.status, 200);
  const other = await linkOf(id, { user: 'checker' });
  assert.equal(other.status, 403, 'o outro usuário tem analytics:export e mesmo assim não baixa');
  assert.equal(code(other), 'PERMISSION_DENIED');
  // o endereço do solicitante não serve para o outro usuário (a assinatura inclui o usuário)
  const stolen = await env.http('GET', mine.body.data.url, { user: 'checker', raw: true });
  assert.equal(stolen.status, 403);
  // nem o arquivo nem a contagem foram tocados pela tentativa
  assert.equal((await e.jobRow(env, id)).download_count, 1);
  const log = await e.accessRows(env, id);
  assert.equal(log.filter((l) => l.action === 'EXPORT_DOWNLOAD').length, 1, 'só o download do solicitante entra no log');
});

test('m9d701 endereço assinado é curto, adulterado não vale e o download não é cacheado', async () => {
  e.at(e.NOW);
  const { id } = await e.requestAndRun(env, target());
  const first = await linkOf(id);
  assert.equal(first.headers.get('cache-control'), 'no-store, private');
  const link = first.body.data;
  assert.equal(new Date(link.urlExpiresAt).getTime() - new Date(e.NOW).getTime(), 15 * 60000, 'validade padrão de 15 min');
  const ok = await env.http('GET', link.url, { raw: true });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('cache-control'), 'no-store, private');
  const sig = /sig=([0-9a-f]+)/.exec(link.url)[1];
  for (const bad of [link.url.replace(sig, `${sig.slice(0, -1)}${sig.endsWith('0') ? '1' : '0'}`), link.url.replace(/exp=\d+/, 'exp=9999999999'), link.url.replace(/&sig=.*/, '')]) {
    const res = await env.http('GET', bad, { raw: true });
    assert.equal(res.status, 403, bad);
    assert.equal(JSON.parse(res.body.toString()).error.code, 'ANALYTICS_EXPORT_LINK_INVALID');
  }
  e.at(new Date(new Date(e.NOW).getTime() + 16 * 60000).toISOString());
  const late = await env.http('GET', link.url, { raw: true });
  assert.equal(late.status, 403, 'passados 15 min o endereço antigo não vale');
  const renewed = await linkOf(id);
  assert.equal(renewed.status, 200, 'um novo endereço sai enquanto o arquivo vale');
  assert.equal(renewed.body.data.downloadCount, 2);
  assert.equal((await e.jobRow(env, id)).download_count, 2);
  e.at(e.NOW);
});

test('m9d701 URL expira e apaga o arquivo', async () => {
  e.at(e.NOW);
  const { id, job } = await e.requestAndRun(env, target());
  const file = await e.fileOf(env, job.file_id);
  const onDisk = path.join(diskStorage.UPLOADS_ROOT, file.storageKey);
  assert.equal(fs.existsSync(onDisk), true);
  e.at(new Date(new Date(e.NOW).getTime() + 25 * 3600000).toISOString());
  const gone = await linkOf(id);
  assert.equal(gone.status, 410, 'após 24 h o download é 410');
  assert.equal(code(gone), 'ANALYTICS_EXPORT_EXPIRED');
  assert.equal(gone.body.error.message, 'O arquivo de exportação expirou.');
  const out = await runExportCleanup({ groupId: env.A.groupId, companyId: env.A.companyId });
  assert.ok(out.expired >= 1);
  const after = await e.jobRow(env, id);
  assert.equal(after.status, 'EXPIRED');
  assert.equal(fs.existsSync(onDisk), false, 'o arquivo saiu do disco');
  assert.equal(await e.fileOf(env, job.file_id), undefined, 'e o registro do arquivo também');
  assert.ok((await e.eventTypes(env, id)).includes('analytics.export.expired'));
  assert.ok((await e.auditRows(env, id)).some((a) => a.action === 'analytics.export.expire'));
  assert.equal((await linkOf(id)).status, 410, 'depois da limpeza continua 410');
  const again = await runExportCleanup({ groupId: env.A.groupId, companyId: env.A.companyId });
  assert.equal(again.expired, 0, 'limpeza repetida não refaz nada');
  e.at(e.NOW);
});

test('m9d701 empresa B não baixa export da empresa A', async () => {
  e.at(e.NOW);
  const { id } = await e.requestAndRun(env, target());
  const mine = await linkOf(id);
  const other = await linkOf(id, { user: 'B' });
  assert.equal(other.status, 404);
  assert.equal(code(other), 'ANALYTICS_EXPORT_NOT_FOUND');
  const viaFile = await env.http('GET', mine.body.data.url, { user: 'B', raw: true });
  assert.equal(viaFile.status, 404, 'o endereço da empresa A não abre arquivo na B');
  assert.equal((await env.http('GET', '/analytics/exports/00000000-0000-4000-8000-000000000000/download')).status, 404);
  assert.equal((await env.http('GET', '/analytics/exports/nao-e-uuid/download')).status, 404);
});

test('m9d701 download sem a permissão e antes de ficar pronto', async () => {
  e.at(e.NOW);
  const res = await env.http('POST', '/analytics/exports', { body: target() });
  const id = res.body.data.jobId;
  const early = await linkOf(id);
  assert.equal(early.status, 409);
  assert.equal(code(early), 'ANALYTICS_EXPORT_NOT_READY');
  const noPerm = await linkOf(id, { perms: ['analytics:read'] });
  assert.equal(noPerm.status, 403);
  assert.equal(noPerm.body.error.message, 'Permissão ausente: analytics:export.');
  await e.runWorker(env);
});

test('m9d701 job preso em andamento vira FAILED pela limpeza', async () => {
  e.at(e.NOW);
  const res = await env.http('POST', '/analytics/exports', { body: target() });
  const id = res.body.data.jobId;
  await env.admin.query("UPDATE analytics.export_jobs SET status = 'RUNNING', updated_at = :t WHERE id = :id", { replacements: { id, t: new Date(new Date(e.NOW).getTime() - 31 * 60000) } });
  const out = await runExportCleanup({ groupId: env.A.groupId, companyId: env.A.companyId });
  assert.equal(out.timedOut, 1);
  const job = await e.jobRow(env, id);
  assert.deepEqual([job.status, job.error_code], ['FAILED', 'ANALYTICS_EXPORT_TIMEOUT']);
});
