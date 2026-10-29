'use strict';

// M9-D701 (3.3) — o worker: QUEUED -> RUNNING -> READY ou FAILED. Permissão reaplicada, RESTRICTED mascarado, cabeçalho de rastreabilidade, dois workers uma
// execução só, erro no meio descarta o arquivo, indicador degradado e teto de linhas. Banco descartável com ClamAV (3310).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const e = require('../_helpers/m9d701Env');
const diskStorage = require('../../../src/utils/diskStorage');

const CPF = '52998224725'; // CPF com dígito verificador válido
let env;
let metric;
before(async () => {
  env = await e.setup();
  metric = await e.metricWithSeries(env, { keys: ['caixa', CPF, 'impostos'] });
});
after(() => e.teardown(env));

const target = () => ({ target: { metricCode: metric.code }, period: e.TODAY });
async function download(id) {
  const link = await env.http('GET', `/analytics/exports/${id}/download`);
  assert.equal(link.status, 200, JSON.stringify(link.body));
  const res = await env.http('GET', link.body.data.url, { raw: true });
  assert.equal(res.status, 200);
  return { link: link.body.data, text: res.body.toString('utf8'), headers: res.headers };
}

test('m9d701 export auditado (pedido, geração, download)', async () => {
  const { id, job, results } = await e.requestAndRun(env, target());
  assert.deepEqual(results.map((r) => r.status), ['READY']);
  assert.equal(job.status, 'READY');
  assert.match(job.file_sha256, /^[0-9a-f]{64}$/);
  assert.equal(job.row_count, 4);
  assert.ok(new Date(job.expires_at).getTime() > Date.now() + 23 * 3600000, 'validade padrão de 24 h');
  const { link } = await download(id);
  assert.equal(link.fileSha256, job.file_sha256);
  assert.equal((await e.jobRow(env, id)).download_count, 1);
  assert.deepEqual((await e.auditRows(env, id)).map((a) => a.action), ['analytics.export.request', 'analytics.export.start', 'analytics.export.finish', 'analytics.export.download']);
  const log = await e.accessRows(env, id);
  assert.deepEqual(log.map((l) => l.action), ['EXPORT_REQUEST', 'EXPORT_GENERATE', 'EXPORT_DOWNLOAD']);
  assert.equal(log[1].rows_returned, 4);
  assert.equal(log[2].rows_returned, 4);
  assert.ok(log.every((l) => l.user_id === env.A.userId));
  assert.deepEqual(await e.eventTypes(env, id), ['analytics.export.requested', 'analytics.export.ready', 'analytics.export.downloaded']);
  const notes = (await env.admin.query("SELECT user_id, channel, title, body FROM core.notifications WHERE body LIKE :like", { replacements: { like: `%${id}%` } }))[0];
  assert.equal(notes.length, 1, 'o solicitante é avisado ao ficar pronto, com o link');
  assert.deepEqual([notes[0].user_id, notes[0].channel], [env.A.userId, 'IN_APP']);
  assert.match(notes[0].body, new RegExp(`/v1/analytics/exports/${id}/download`));
});

test('m9d701 cabeçalho do arquivo traz versão, período e freshness', async () => {
  const { id } = await e.requestAndRun(env, target());
  const { text, headers } = await download(id);
  assert.ok(text.startsWith('﻿# exportacao: METRIC'), 'UTF-8 com BOM');
  assert.match(text, /\r\n/);
  assert.match(text, new RegExp(`# periodo: ${e.TODAY}`));
  assert.match(text, new RegExp(`# usuario: ${env.A.userId}`));
  assert.match(text, new RegExp(`# indicador: ${metric.code.replace('.', '\\.')} \\| versao 1 \\| status_qualidade OK \\| freshness FRESH \\(Atualizado às [0-9:]{5}\\) \\| sourceSnapshotAt 2026-10-29T14:5`));
  assert.match(text, /\r\nindicador;versao;serie;valor;unidade;natureza;status\r\n/);
  assert.match(text, new RegExp(`${metric.code.replace('.', '\\.')};1;principal;100\\.0000;`));
  assert.match(headers.get('content-type'), /^text\/csv/);
  assert.match(headers.get('content-disposition'), /^attachment; filename="exportacao-/);
  assert.equal(headers.get('cache-control'), 'no-store, private');
});

test('m9d701 RESTRICTED sempre mascarado (nenhuma permissão desliga)', async () => {
  const { id, job } = await e.requestAndRun(env, target());
  const { text } = await download(id);
  assert.ok(!text.includes(CPF), 'o CPF cru não está no arquivo');
  assert.match(text, /\*\*\*\.982\.247-\*\*/);
  assert.ok(job.masked_fields.includes('serie'), `campos mascarados registrados: ${JSON.stringify(job.masked_fields)}`);
  const log = await e.accessRows(env, id);
  assert.equal(log.find((l) => l.action === 'EXPORT_GENERATE').masking_applied, true);
  // mesmo um solicitante com TODAS as permissões do BI recebe o mascarado
  const todas = [...e.PERMS, 'analytics:manage', 'analytics:read:group', 'analytics:audit:read'];
  const res = await env.http('POST', '/analytics/exports', { body: target(), perms: todas });
  assert.equal(res.status, 202);
  await e.runWorker(env);
  assert.ok(!(await download(res.body.data.jobId)).text.includes(CPF));
});

test('m9d701 permissão revogada antes da geração falha o job', async () => {
  const res = await env.http('POST', '/analytics/exports', { body: target() });
  assert.equal(res.status, 202);
  await env.admin.query("DELETE FROM core.role_permissions WHERE role_id = :r AND permission_id = (SELECT id FROM core.permissions WHERE code = 'analytics:export')", { replacements: { r: env.roleId } });
  try {
    const out = await e.runWorker(env);
    assert.deepEqual(out.map((r) => [r.status, r.errorCode]), [['FAILED', 'ANALYTICS_EXPORT_PERMISSION_REVOKED']]);
  } finally {
    await env.admin.query("INSERT INTO core.role_permissions (id, role_id, permission_id, created_at, updated_at) SELECT gen_random_uuid(), :r, id, now(), now() FROM core.permissions WHERE code = 'analytics:export'", { replacements: { r: env.roleId } });
  }
  const job = await e.jobRow(env, res.body.data.jobId);
  assert.deepEqual([job.status, job.error_code, job.file_id, job.file_sha256], ['FAILED', 'ANALYTICS_EXPORT_PERMISSION_REVOKED', null, null]);
  const link = await env.http('GET', `/analytics/exports/${job.id}/download`);
  assert.equal(link.status, 200, 'o job FAILED responde 200 com o motivo');
  assert.deepEqual([link.body.data.status, link.body.data.code, link.body.data.message], ['FAILED', 'ANALYTICS_EXPORT_PERMISSION_REVOKED', 'Job FAILED: você não tem mais permissão para este dado.']);
  assert.equal((await e.accessRows(env, job.id)).filter((l) => l.action === 'EXPORT_GENERATE').length, 0, 'nada foi gerado nem logado como geração');
});

test('m9d701 dois workers executam o job uma vez', async () => {
  const res = await env.http('POST', '/analytics/exports', { body: target() });
  const results = (await Promise.all([e.runWorker(env), e.runWorker(env), e.runWorker(env)])).flat();
  assert.deepEqual(results.map((r) => r.status), ['READY'], 'um só worker executou');
  const id = res.body.data.jobId;
  assert.deepEqual(await e.eventTypes(env, id), ['analytics.export.requested', 'analytics.export.ready']);
  assert.equal((await e.accessRows(env, id)).filter((l) => l.action === 'EXPORT_GENERATE').length, 1);
  const files = (await env.admin.query("SELECT count(*)::int AS n FROM people.files WHERE id = (SELECT file_id FROM analytics.export_jobs WHERE id = :id)", { replacements: { id } }))[0][0].n;
  assert.equal(files, 1);
});

test('m9d701 erro no meio descarta o arquivo e marca FAILED', async () => {
  let storageKey;
  const { id, job, results } = await e.requestAndRun(env, target(), { hooks: { afterUpload: async ({ file }) => { storageKey = file.storageKey; throw new Error('queda no meio da geração'); } } });
  assert.deepEqual(results.map((r) => [r.status, r.errorCode]), [['FAILED', 'ANALYTICS_EXPORT_FAILED']]);
  assert.ok(storageKey, 'o arquivo chegou a ser gravado antes da queda');
  assert.equal(fs.existsSync(path.join(diskStorage.UPLOADS_ROOT, storageKey)), false, 'o arquivo incompleto foi apagado do disco');
  assert.deepEqual([job.status, job.file_id, job.file_sha256, job.row_count], ['FAILED', null, null, null], 'nunca READY sem hash');
  const rows = (await env.admin.query('SELECT count(*)::int AS n FROM people.files WHERE storage_key = :k', { replacements: { k: storageKey } }))[0][0].n;
  assert.equal(rows, 0, 'nenhum registro de arquivo sobrou');
  assert.deepEqual((await e.eventTypes(env, id)), ['analytics.export.requested'], 'sem evento de pronto');
  const link = await env.http('GET', `/analytics/exports/${id}/download`);
  assert.equal(link.body.data.status, 'FAILED');
});

test('m9d701 indicador que ficou degradado depois do pedido não é exportado', async () => {
  const m = await e.metricWithSeries(env, { series: 1 });
  const res = await env.http('POST', '/analytics/exports', { body: { target: { metricCode: m.code } } });
  assert.equal(res.status, 202);
  await e.recordCheck(env.A, { metrics: [m.code] });
  const out = await e.runWorker(env);
  assert.deepEqual(out.map((r) => [r.status, r.errorCode]), [['FAILED', 'ANALYTICS_EXPORT_DEGRADED_BLOCKED']]);
  assert.equal((await e.jobRow(env, res.body.data.jobId)).file_id, null);
});

test('m9d701 arquivo acima do teto de linhas falha em vez de truncar', async () => {
  await e.setParam(env, 'analytics.export.max_linhas', 2);
  try {
    const { job, results } = await e.requestAndRun(env, target());
    assert.deepEqual(results.map((r) => [r.status, r.errorCode]), [['FAILED', 'ANALYTICS_EXPORT_TOO_LARGE']]);
    assert.equal(job.file_id, null);
  } finally {
    await e.setParam(env, 'analytics.export.max_linhas', 50000);
  }
});

test('m9d701 exportação de painel traz os indicadores do painel e recorte por série', async () => {
  const dashboardCode = await e.publishPanel(env, metric.code);
  const res = await env.http('POST', '/analytics/exports', { body: { target: { dashboardCode }, filters: { dimensionKeys: ['caixa'] }, period: e.TODAY } });
  assert.equal(res.status, 202, JSON.stringify(res.body));
  await e.runWorker(env);
  const job = await e.jobRow(env, res.body.data.jobId);
  assert.deepEqual([job.status, job.dashboard_code, job.metric_code, job.row_count], ['READY', dashboardCode, null, 2]);
  const { text } = await download(job.id);
  assert.match(text, new RegExp(`# exportacao: DASHBOARD ${dashboardCode}`));
  assert.match(text, /;caixa;10\.0000;/);
  assert.ok(!text.includes('impostos'), 'a série fora do recorte não sai');
});

test('m9d701 exportação do consolidado do grupo traz uma linha por empresa, as eliminações e o consolidado', async () => {
  const rules = require('../../../src/features/analytics/metrics/consolidation/rules');
  rules.registerConsolidationRule(metric.code, { kind: 'SUM', intercompany: null });
  try {
    const noGroupPerm = await env.http('POST', '/analytics/exports', { body: { target: { metricCode: metric.code }, groupId: env.A.groupId }, perms: ['analytics:read', 'analytics:export', 'finance:read'] });
    assert.equal(noGroupPerm.status, 403, 'consolidado do grupo exige analytics:read:group');
    const other = await env.http('POST', '/analytics/exports', { body: { target: { metricCode: metric.code }, groupId: env.B.groupId } });
    assert.equal(other.status, 404, 'grupo alheio é 404');
    const { id, job, results } = await e.requestAndRun(env, { target: { metricCode: metric.code }, groupId: env.A.groupId, period: e.TODAY });
    assert.deepEqual(results.map((r) => r.status), ['READY'], JSON.stringify(results));
    assert.equal(job.scope.level, 'GROUP');
    const { text } = await download(id);
    assert.match(text, /# exportacao: METRIC .*\r\n# periodo/);
    assert.match(text, /\r\nindicador;empresa;valor;unidade;status\r\n/);
    assert.match(text, /;Eliminações do grupo;/);
    assert.match(text, /;Consolidado;100;/);
  } finally {
    rules.unregisterConsolidationRule(metric.code);
  }
});
