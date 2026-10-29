'use strict';

// M9-D822 — POST /exports, GET /exports/:id e download pela API real (banco descartável): Idempotency-Key, permissões, MFA, geração assíncrona, endereço assinado, auditoria,
// 410 depois da expiração forçada e as rotas antigas redirecionadas.
process.env.PORT = process.env.M9D822_HTTP_TEST_PORT || '21822';
process.env.DLP_EXPORT_INLINE_DISABLED = 'false'; // a rota dispara a geração depois da resposta

const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { startHttp, stopHttp } = require('../_helpers/m9d806Http');
const env = require('../_helpers/exportsEnv');

let http;
env.useMonth(env.uniqueMonth());
let A;
let restore;
const skip = () => (http && http.skip) || (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
const EXPORT = 'governance:dlp:export';

before(async () => {
  if (!env.DISPOSABLE) return;
  restore = await env.withRolePermissions({ 'CI GESTOR': { [EXPORT]: true, 'finance:read': true }, 'CI MAKER': { [EXPORT]: true, 'finance:read': true }, 'CI LEITURA': { [EXPORT]: false } });
  http = await startHttp({ port: process.env.PORT, grants: {}, logins: { gestorA: ['A', 'gestor'], makerA: ['A', 'maker'], leituraA: ['A', 'leitura'], gestorB: ['B', 'gestor'] } });
  A = http.tenants.A;
  await env.seedEntries(A, 3);
});
afterEach(async () => { if (env.DISPOSABLE) await env.cleanExports(); });
after(async () => {
  if (env.DISPOSABLE) {
    await env.cleanExports();
    await restore();
  }
  await stopHttp({});
});

const payload = (over = {}) => ({ resourceType: 'finance.entries', filter: { competenceMonth: env.state.month }, format: 'CSV', purpose: 'CONTABIL', justification: env.JUSTIFICATION, ...over });
const post = (who, body, key) => http.call(who, 'POST', '/exports', body, key === null ? {} : { 'Idempotency-Key': key || env.nextKey('http') });
async function untilReady(who, id) {
  for (let i = 0; i < 60; i += 1) {
    const res = await http.call(who, 'GET', `/exports/${id}`);
    if (res.body.data && ['READY', 'FAILED'].includes(res.body.data.status)) return res;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error('a exportação não ficou pronta');
}
const raw = (who, path) => fetch(`${http.baseUrl}${path.replace(/^\/api\/v1/, '')}`, { headers: { Authorization: `Bearer ${http.tokens[who]}` } });

test('m9d822 sem Idempotency-Key 400, sem permissão 403 e corpo inválido 400', { skip: skip() }, async () => {
  const noKey = await post('gestorA', payload(), null);
  assert.deepEqual([noKey.status, noKey.body.error.code, noKey.body.error.message], [400, 'GOV_IDEMPOTENCY_KEY_REQUIRED', 'Envie o cabeçalho Idempotency-Key.']);
  assert.ok(noKey.body.error.traceId);
  const noPerm = await post('leituraA', payload());
  assert.deepEqual([noPerm.status, noPerm.body.error.code, noPerm.body.error.details.required], [403, 'PERMISSION_DENIED', EXPORT]);
  const bad = await post('gestorA', payload({ resourceType: 'x.y' }));
  assert.deepEqual([bad.status, bad.body.error.code], [400, 'GOV_EXPORT_RESOURCE_INVALID']);
});

test('m9d822 HIGH sem MFA recente devolve 403 MFA_STEP_UP_REQUIRED e o pedido fica BLOCKED', { skip: skip() }, async () => {
  await env.revokeMfa(A.userId);
  const res = await post('gestorA', payload());
  assert.deepEqual([res.status, res.body.error.code, res.body.error.message], [403, 'MFA_STEP_UP_REQUIRED', 'Confirme o código de verificação para continuar.']);
  const { rows } = await env.adminQuery("SELECT status, block_reason FROM governance.export_jobs WHERE id = $1", [res.body.error.details.exportJobId]);
  assert.deepEqual([rows[0].status, rows[0].block_reason], ['BLOCKED', 'MFA']);
});

test('m9d822 exportação HIGH real: 202, job READY, URL assinada, arquivo, auditoria de download e 410 depois da expiração', { skip: skip() }, async () => {
  await env.grantMfa(A);
  const created = await post('gestorA', payload({ watermark: true }));
  assert.equal(created.status, 202, JSON.stringify(created.body));
  assert.deepEqual(Object.keys(created.body.data).sort(), ['exportJobId', 'status']);
  const id = created.body.data.exportJobId;
  const ready = await untilReady('gestorA', id);
  assert.equal(ready.body.data.status, 'READY', JSON.stringify(ready.body));
  assert.equal(ready.body.data.rowCount, 3);
  assert.equal(ready.body.data.classification, 'HIGH');
  assert.match(ready.body.data.downloadUrl, new RegExp(`^/api/v1/exports/${id}/download\\?exp=\\d+&sig=[0-9a-f]{64}$`));
  const row = await env.jobOf(id);
  assert.ok(Math.abs((new Date(row.expires_at) - Date.now()) / 3600000 - 48) < 0.1, 'expira em 48 h');

  const file = await raw('gestorA', ready.body.data.downloadUrl);
  assert.equal(file.status, 200);
  assert.match(file.headers.get('content-type'), /^text\/csv/);
  assert.match(file.headers.get('content-disposition'), /attachment; filename="finance\.entries-/);
  assert.equal(file.headers.get('x-content-sha256'), row.file_sha256);
  const text = await file.text();
  assert.match(text, /Id;Competência;Natureza;Tipo;Situação;Valor;Vencimento;Liquidação;Descrição;Dinheiro de terceiros;_wm/u);
  assert.equal(text.trimEnd().split('\n').length, 1 + 3 + 1, 'cabeçalho, 3 linhas e a linha da marca');
  assert.match(text, /# Exportado por /u);
  const audits = await env.auditOf('dlp.export.downloaded', id);
  assert.equal(audits.length, 1);
  assert.ok(audits[0].after_json.ip && audits[0].after_json.userAgent, 'IP e user agent na auditoria');
  assert.equal((await env.auditOf('dlp.export.generated', id)).length, 1);

  const other = await http.call('makerA', 'GET', `/exports/${id}`);
  assert.deepEqual([other.status, other.body.error.code], [403, 'GOV_EXPORT_NOT_OWNER']);
  const foreign = await http.call('gestorB', 'GET', `/exports/${id}`);
  assert.deepEqual([foreign.status, foreign.body.error.code], [404, 'GOV_NOT_FOUND'], 'de outra empresa: 404');

  await env.adminQuery("UPDATE governance.export_jobs SET expires_at = now() - interval '1 second' WHERE id = $1", [id]);
  const gone = await raw('gestorA', ready.body.data.downloadUrl);
  assert.equal(gone.status, 410);
  assert.equal((await gone.json()).error.code, 'GOV_EXPORT_EXPIRED');
});

test('m9d822 mesma Idempotency-Key repete o mesmo pedido e outro corpo é 409', { skip: skip() }, async () => {
  await env.grantMfa(A);
  const key = env.nextKey('same');
  const first = await post('gestorA', payload(), key);
  const second = await post('gestorA', payload(), key);
  assert.deepEqual([first.status, second.status, second.body.data.exportJobId === first.body.data.exportJobId], [202, 202, true]);
  assert.equal(second.headers.get('idempotent-replay'), 'true');
  const clash = await post('gestorA', payload({ format: 'PDF' }), key);
  assert.deepEqual([clash.status, clash.body.error.code], [409, 'GOV_DLP_IDEMPOTENCY_CONFLICT']);
  const sameKeyOtherUser = await post('makerA', payload(), key);
  assert.notEqual(sameKeyOtherUser.body.data && sameKeyOtherUser.body.data.exportJobId, first.body.data.exportJobId, 'a chave é de cada usuário');
});

test('m9d822 GET /exports/catalog lista recursos, finalidades e formatos; as rotas antigas devolvem 410 GOV_EXPORT_MOVED', { skip: skip() }, async () => {
  const catalog = await http.call('gestorA', 'GET', '/exports/catalog');
  assert.equal(catalog.status, 200);
  assert.ok(catalog.body.data.resources.some((r) => r.code === 'finance.entries' && r.columns.some((c) => c.key === 'description' && c.classification === 'RESTRICTED')));
  assert.ok(catalog.body.data.purposes.includes('CONTABIL') && catalog.body.data.justificationMin === 20);
  assert.deepEqual(catalog.body.data.formats, ['CSV', 'XLSX', 'PDF']);
  const old = await http.call('gestorA', 'GET', '/finance/exports/entries?competenceMonth=1999-01');
  assert.deepEqual([old.status, old.body.error.code], [410, 'GOV_EXPORT_MOVED']);
});
