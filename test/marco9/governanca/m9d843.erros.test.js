'use strict';

// M9-D843 — catálogo de códigos de erro, varredura de CI (prefixo GOV_ e códigos desconhecidos), traceId dentro de error e paginação única. Parte sem banco, parte na API real.
process.env.PORT = process.env.M9D843_ERROS_TEST_PORT || '21845';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { startHttp, stopHttp } = require('../_helpers/m9d806Http');
const exportsEnv = require('../_helpers/exportsEnv');
const env = require('../_helpers/m9d843Env');
const { buildCatalog, checkCatalog } = require('../../../src/features/core-governance/api-governance/standards/errorCatalog.build');
const { readData, entriesFromData } = require('../../../src/features/core-governance/api-governance/standards/errorCatalog.data');
const { renderMarkdown } = require('../../../src/features/core-governance/api-governance/standards/errorCatalog.markdown');
const { syncErrorCatalog } = require('../../../src/features/core-governance/api-governance/standards/errorCatalog.sync');
const { checkPagination, buildPagination } = require('../../../src/features/core-governance/api-governance/standards/pagination.helper');

const ROOT = path.resolve(__dirname, '../../..');
const GOV = path.join(ROOT, 'src/features/core-governance');
let http;
let restore;
const skip = () => (http && http.skip) || (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
const fixture = (files) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm9d843-'));
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  return dir;
};

before(async () => {
  if (!env.DISPOSABLE) return;
  restore = await exportsEnv.withRolePermissions({ 'CI GESTOR': { 'governance:bcp:record': true } }); // as permissões entram no token no login
  http = await startHttp({ port: process.env.PORT, grants: {}, logins: { gestorA: ['A', 'gestor'], leituraA: ['A', 'leitura'] } });
});
after(async () => { if (restore) await restore(); await stopHttp({}); });

test('m9d843 todo AppError de core-governance usa código do catálogo', () => {
  assert.deepEqual(checkCatalog({ dir: GOV, data: readData() }), []);
  const run = spawnSync('node', [path.join(ROOT, 'scripts/checkErrorCodes.js')], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, LOG_LEVEL: 'silent' } });
  assert.equal(run.status, 0, run.stderr + run.stdout);
  const dir = fixture({ 'a.js': "const e = govError(409, 'GOV_NAO_CATALOGADO', 'Algo novo.');\n" });
  const problems = checkCatalog({ dir, data: readData() });
  assert.deepEqual(problems.map((p) => [p.rule, p.code]), [['GOV_ERROR_CODE_UNKNOWN', 'GOV_NAO_CATALOGADO']]);
  assert.equal(problems[0].message, 'Código de erro não catalogado: GOV_NAO_CATALOGADO.');
  const failing = spawnSync('node', [path.join(ROOT, 'scripts/checkErrorCodes.js'), '--dir', dir], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(failing.status, 1);
  assert.match(failing.stderr, /GOV_ERROR_CODE_UNKNOWN Código de erro não catalogado: GOV_NAO_CATALOGADO\./);
  const fresh = buildCatalog({ dir, data: readData(), since: '1.1.0' });
  assert.equal(fresh.codes.GOV_NAO_CATALOGADO.since, '1.1.0', 'código novo entra com a versão atual');
});

test('m9d843 código de erro sem prefixo GOV_ fora da lista fechada reprova em core-governance e código legado fora da pasta passa', () => {
  const inside = fixture({ 'b.js': "throw new AppError('Falhou.', 400, 'MEU_ERRO_LEGADO');\nthrow AppError.conflict('Duplicado.', 'OUTRO_LEGADO');\nthrow govError(403, 'PERMISSION_DENIED', 'Sem permissão.');\n" });
  const problems = checkCatalog({ dir: inside, data: readData() });
  assert.deepEqual(problems.map((p) => [p.rule, p.code]), [['GOV_ERROR_CODE_PREFIX', 'MEU_ERRO_LEGADO'], ['GOV_ERROR_CODE_PREFIX', 'OUTRO_LEGADO']], 'a lista fechada (PERMISSION_DENIED) passa');
  const outside = fixture({});
  fs.writeFileSync(path.join(outside, 'legado.js'), "throw new AppError('Legado.', 404, 'LEGAL_ALGO_LEGADO');\n");
  const scanned = path.join(GOV);
  assert.deepEqual(checkCatalog({ dir: scanned, data: readData() }), [], 'só core-governance é varrida: o legado de fora não entra');
  assert.ok(!fs.readdirSync(GOV).some((f) => f.includes('legado')));
});

test('m9d843 o catálogo gerado (JSON, docs/ERROR_CODES.md e tabela governance.error_catalog) é uma só fonte', { skip: skip() }, async () => {
  const doc = fs.readFileSync(path.join(ROOT, 'docs/ERROR_CODES.md'), 'utf8');
  assert.equal(doc, renderMarkdown(entriesFromData()), 'docs/ERROR_CODES.md atualizado');
  assert.match(doc, /\| `GOV_RATE_LIMITED` \| 429 \| Muitas requisições\. Tente novamente em <N> segundos\. \| api-governance \|/);
  await syncErrorCatalog();
  const { rows } = await env.adminQuery('SELECT code, http_status, message_pt, module, since_version, deprecated FROM governance.error_catalog ORDER BY code');
  assert.deepEqual(rows.map((r) => [r.code, r.http_status, r.message_pt, r.module, r.since_version, r.deprecated]), entriesFromData().map((e) => [e.code, e.status, e.message, e.module, e.since, e.deprecated]));
  assert.equal(await syncErrorCatalog(), 0, 'segunda sincronização não muda nada');
});

test('m9d843 corpo de erro tem error.traceId e nunca traceId na raiz', { skip: skip() }, async () => {
  const governance = await http.call('leituraA', 'GET', '/bcp/manual-operations');
  const platform = await fetch(`${http.baseUrl}/people`);
  for (const res of [governance, { status: platform.status, body: await platform.json(), headers: platform.headers }]) {
    assert.ok(res.status >= 400);
    assert.equal(res.body.success, false);
    assert.ok(res.body.error.traceId, JSON.stringify(res.body));
    assert.equal(res.body.traceId, undefined, 'nunca na raiz');
    assert.equal(res.body.error.traceId, res.headers.get('x-correlation-id'), 'igual ao cabeçalho X-Correlation-Id');
  }
});

test('m9d843 pageSize acima de 200 devolve 400', { skip: skip() }, async () => {
  const res = await http.call('gestorA', 'GET', '/bcp/manual-operations?pageSize=500');
  assert.equal(res.status, 400, JSON.stringify(res.body));
  assert.equal(res.body.error.code, 'GOV_VALIDATION_PAGINATION');
  assert.equal(res.body.error.message, 'Parâmetros de paginação inválidos.');
  assert.equal(res.body.error.details.problems[0].field, 'pageSize');
  for (const bad of ['page=0', 'page=abc', 'pageSize=0', 'pageSize=201', 'pageSize=10.5', 'page=-1']) {
    const r = await http.call('gestorA', 'GET', `/bcp/manual-operations?${bad}`);
    assert.deepEqual([bad, r.status, r.body.error && r.body.error.code], [bad, 400, 'GOV_VALIDATION_PAGINATION']);
  }
  assert.deepEqual(checkPagination({ page: '2', pageSize: '200' }), { page: 2, pageSize: 200 });
  assert.deepEqual(checkPagination({}), {});
  assert.deepEqual(buildPagination({ page: 2, pageSize: 50, total: 120 }), { page: 2, pageSize: 50, total: 120, totalPages: 3 });
});
