'use strict';

// M9-D820 — GET /dlp/policies e PUT /dlp/policies/:classificacao/:acao pela API real (banco descartável): permissões, piso do livro, auditoria e isolamento.
process.env.PORT = process.env.M9D820_HTTP_TEST_PORT || '21820';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startHttp, stopHttp } = require('../_helpers/m9d806Http');
const env = require('../_helpers/dlpEnv');

const EXPORT = 'governance:dlp:export';
const ADMIN = 'governance:dlp:admin';
let http;
before(async () => {
  if (env.DISPOSABLE) {
    await env.setRolePermission('CI GESTOR', ADMIN, true);
    await env.setRolePermission('CI MAKER', EXPORT, true);
    await env.setRolePermission('CI LEITURA', EXPORT, false);
    await env.setRolePermission('CI LEITURA', ADMIN, false);
  }
  http = await startHttp({ port: process.env.PORT, grants: {}, logins: { gestorA: ['A', 'gestor'], makerA: ['A', 'maker'], leituraA: ['A', 'leitura'], gestorB: ['B', 'gestor'] } });
});
after(async () => {
  if (env.DISPOSABLE) {
    await env.setRolePermission('CI GESTOR', ADMIN, false);
    await env.setRolePermission('CI MAKER', EXPORT, false);
    await env.cleanDlp();
  }
  await stopHttp({});
});

test('m9d820 sem permissão a leitura e a escrita da política devolvem 403', async (t) => {
  if (http.skip) return t.skip(http.skip);
  const read = await http.call('leituraA', 'GET', '/dlp/policies');
  assert.equal(read.status, 403);
  assert.equal(read.body.error.code, 'PERMISSION_DENIED');
  assert.equal(read.body.error.details.required, EXPORT);
  const write = await http.call('makerA', 'PUT', '/dlp/policies/HIGH/EXPORT', { requireAudit: true });
  assert.equal(write.status, 403, 'dlp:export lê mas não altera');
  assert.equal(write.body.error.details.required, ADMIN);
  assert.ok(write.body.error.traceId);
});

test('m9d820 GET /dlp/policies mostra as 24 linhas e as 4 classes na ação EXPORT (dlp:export ou dlp:admin)', async (t) => {
  if (http.skip) return t.skip(http.skip);
  for (const who of ['makerA', 'gestorA']) {
    const res = await http.call(who, 'GET', '/dlp/policies');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.length, 24);
    const exp = res.body.data.filter((p) => p.action === 'EXPORT');
    assert.deepEqual(exp.map((p) => [p.classification, p.maxRows, p.maxExpiryHours]), [['LOW', 100000, 168], ['MEDIUM', 50000, 72], ['HIGH', 10000, 48], ['RESTRICTED', 1000, 24]]);
  }
});

test('m9d820 PUT que enfraquece o piso devolve 422 GOV_DLP_FLOOR_VIOLATION e política inexistente 400', async (t) => {
  if (http.skip) return t.skip(http.skip);
  const floor = await http.call('gestorA', 'PUT', '/dlp/policies/RESTRICTED/EXPORT', { require_mfa: false });
  assert.deepEqual([floor.status, floor.body.error.code, floor.body.error.message], [422, 'GOV_DLP_FLOOR_VIOLATION', 'Esta classificação exige justificativa, verificação em duas etapas, auditoria e expiração.']);
  const bad = await http.call('gestorA', 'PUT', '/dlp/policies/SECRET/EXPORT', { allowed: true });
  assert.deepEqual([bad.status, bad.body.error.code, bad.body.error.message], [400, 'GOV_DLP_POLICY_INVALID', 'Classificação ou ação inválida.']);
  const list = await http.call('gestorA', 'GET', '/dlp/policies');
  assert.equal(list.body.data.find((p) => p.classification === 'RESTRICTED' && p.action === 'EXPORT').requireMfa, true);
});

test('m9d820 PUT de dlp:admin grava a política nova, audita antes e depois e não vaza para a outra empresa', async (t) => {
  if (http.skip) return t.skip(http.skip);
  const res = await http.call('gestorA', 'PUT', '/dlp/policies/MEDIUM/EXPORT', { maxExpiryHours: 24 });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.maxExpiryHours, 24);
  const audit = await env.adminQuery("SELECT before_json, after_json FROM audit.audit_log WHERE company_id = $1 AND action = 'governance.dlp_policy.changed' ORDER BY occurred_at DESC LIMIT 1", [http.tenants.A.companyId]);
  assert.equal(audit.rows[0].before_json.maxExpiryHours, 72);
  assert.equal(audit.rows[0].after_json.maxExpiryHours, 24);
  const other = await http.call('gestorB', 'GET', '/dlp/policies');
  assert.equal(other.status, 200);
  assert.equal(other.body.data.find((p) => p.classification === 'MEDIUM' && p.action === 'EXPORT').maxExpiryHours, 72, 'a política de B continua a padrão');
});
