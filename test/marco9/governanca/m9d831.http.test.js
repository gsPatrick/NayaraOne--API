'use strict';

// M9-D831 — operações manuais pela API real (banco descartável): duas operações do mesmo correlation_ref, duplicata recusada, evento no outbox, permissões, setor, PATCH e GET.
process.env.PORT = process.env.M9D831_HTTP_TEST_PORT || '21831';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startHttp, stopHttp } = require('../_helpers/m9d806Http');
const env = require('../_helpers/bcpEnv');

let http;
let A;
let restore;
const skip = () => (http && http.skip) || (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
const RECORD = 'governance:bcp:record';
const IMPORT = 'governance:bcp:import';
const CORR = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

before(async () => {
  if (!env.DISPOSABLE) return;
  restore = await env.withRolePermissions({ 'CI GESTOR': { [RECORD]: true, [IMPORT]: true }, 'CI MAKER': { [RECORD]: false, [IMPORT]: true }, 'CI LEITURA': { [RECORD]: false, [IMPORT]: false } });
  http = await startHttp({ port: process.env.PORT, grants: {}, logins: { gestorA: ['A', 'gestor'], makerA: ['A', 'maker'], leituraA: ['A', 'leitura'], gestorB: ['B', 'gestor'] } });
  A = http.tenants.A;
  await env.cleanBcp();
  await env.setSectorRoles(A, { FINANCEIRO: ['CI GESTOR', 'CI MAKER'], OBRAS: ['CI GESTOR'] });
  await env.setSectorRoles(http.tenants.B, { FINANCEIRO: ['CI GESTOR'] });
});
after(async () => {
  if (env.DISPOSABLE) { await env.cleanBcp(); await restore(); }
  await stopHttp({});
});

const post = async (who, over = {}, tenant = A) => http.call(who, 'POST', '/bcp/manual-operations', env.body(tenant, { evidenceFileId: await env.evidence(tenant), ...over }));

test('m9d831 HTTP: duas operações do mesmo caso, duplicata recusada e o evento no outbox', { skip: skip() }, async () => {
  const ref1 = env.reference('FIN');
  const ref2 = env.reference('OBR');
  const first = await post('gestorA', { manualReference: ref1, correlationRef: CORR });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.deepEqual([first.body.data.status, first.body.data.correlationRef, first.body.data.manualReference], ['RECORDED', CORR, ref1]);
  const second = await post('gestorA', { sector: 'OBRAS', manualReference: ref2, correlationRef: CORR, formType: 'DIARIO_OBRA', intendedAction: 'DAILY_REPORT', payload: env.DIARIO });
  assert.equal(second.status, 201, JSON.stringify(second.body));

  const dup = await post('gestorA', { manualReference: ref1 });
  assert.equal(dup.status, 409);
  assert.deepEqual([dup.body.success, dup.body.error.code, dup.body.error.message], [false, 'GOV_BCP_REFERENCE_DUPLICATE', 'Este número de formulário já foi registrado.']);
  assert.ok(dup.body.error.traceId, 'o envelope de erro de governança traz o traceId');

  const listed = await http.call('gestorA', 'GET', `/bcp/manual-operations?correlationRef=${CORR}`);
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.data.map((o) => o.manualReference).sort(), [ref1, ref2].sort());

  for (const ref of [ref1, ref2]) assert.equal((await env.outbox(`bcp.manual_operation.recorded:${A.companyId}:${ref}`)).length, 1, `evento de ${ref}`);
});

test('m9d831 HTTP: sem permissão 403, módulo, setor, evidência, data e payload inválido', { skip: skip() }, async () => {
  // A plataforma confere o anexo (FILE_ATTACH_FORBIDDEN) antes da rota; sem arquivo no corpo, a recusa vem da permissão.
  const noPermission = await post('leituraA', { evidenceFileId: null });
  assert.deepEqual([noPermission.status, noPermission.body.error.code], [403, 'PERMISSION_DENIED']);
  const importOnly = await post('makerA', { evidenceFileId: null });
  assert.deepEqual([importOnly.status, importOnly.body.error.code], [403, 'PERMISSION_DENIED'], 'quem só importa não registra');

  const noEvidence = await http.call('gestorA', 'POST', '/bcp/manual-operations', env.body(A, { evidenceFileId: null }));
  assert.deepEqual([noEvidence.status, noEvidence.body.error.code], [422, 'GOV_BCP_EVIDENCE_REQUIRED']);
  const future = await post('gestorA', { occurredAt: '2999-01-01' });
  assert.deepEqual([future.status, future.body.error.code], [422, 'GOV_BCP_DATE_INVALID']);
  const wrongPrefix = await post('gestorA', { manualReference: env.reference('ATD') });
  assert.deepEqual([wrongPrefix.status, wrongPrefix.body.error.code], [422, 'GOV_BCP_REFERENCE_INVALID']);
  const wrongSector = await post('gestorA', { sector: 'JURIDICO', manualReference: env.reference('JUR') });
  assert.deepEqual([wrongSector.status, wrongSector.body.error.code], [403, 'GOV_BCP_SECTOR_FORBIDDEN'], 'JURIDICO não está no mapa do gestor');
  const invalidPayload = await post('gestorA', { payload: { forma: 'PIX' } });
  assert.equal(invalidPayload.status, 201, 'payload inválido nunca é recusado no registro');
  assert.ok(invalidPayload.body.data.validationErrors.length >= 5);
});

test('m9d831 HTTP: PATCH, edição bloqueada e leitura limitada ao setor', { skip: skip() }, async () => {
  const created = await post('gestorA', { payload: { forma: 'PIX' } });
  const id = created.body.data.id;
  const invalid = await http.call('gestorA', 'PATCH', `/bcp/manual-operations/${id}`, { payload: { forma: 'PIX' } });
  assert.deepEqual([invalid.status, invalid.body.error.code], [422, 'GOV_BCP_PAYLOAD_INVALID']);
  const fixed = await http.call('gestorA', 'PATCH', `/bcp/manual-operations/${id}`, { payload: env.RECEBIMENTO });
  assert.equal(fixed.status, 200, JSON.stringify(fixed.body));
  assert.deepEqual(fixed.body.data.validationErrors, []);
  await env.adminQuery("UPDATE governance.manual_operations SET status = 'IMPORTED' WHERE id = $1", [id]);
  const locked = await http.call('gestorA', 'PATCH', `/bcp/manual-operations/${id}`, { payload: env.RECEBIMENTO });
  assert.deepEqual([locked.status, locked.body.error.code], [409, 'GOV_BCP_NOT_EDITABLE']);

  const asImporter = await http.call('makerA', 'GET', '/bcp/manual-operations');
  assert.equal(asImporter.status, 200, 'bcp:import também consulta');
  assert.ok(asImporter.body.data.every((o) => o.sector === 'FINANCEIRO'), 'e só vê o setor dele (FINANCEIRO)');
  const forbidden = await http.call('leituraA', 'GET', '/bcp/manual-operations');
  assert.equal(forbidden.status, 403);
  const otherCompany = await http.call('gestorB', 'GET', '/bcp/manual-operations');
  assert.equal(otherCompany.status, 200);
  assert.equal(otherCompany.body.data.length, 0, 'a empresa B não vê as operações da A');
  const idOfOther = await http.call('gestorB', 'PATCH', `/bcp/manual-operations/${id}`, { payload: env.RECEBIMENTO });
  assert.equal(idOfOther.status, 404);
});

test('m9d831 HTTP: módulo desligado pelo administrador responde 403 GOV_MODULE_DISABLED', { skip: skip() }, async () => {
  const { upsertSetting } = require('../../../src/features/settings/settings.service');
  await env.inTx(A, (tx) => upsertSetting('governanca.modulos.bcp.habilitado', false, env.tenantOf(A), A.userId, tx));
  try {
    const res = await post('gestorA');
    assert.deepEqual([res.status, res.body.error.code], [403, 'GOV_MODULE_DISABLED']);
  } finally {
    await env.inTx(A, (tx) => upsertSetting('governanca.modulos.bcp.habilitado', true, env.tenantOf(A), A.userId, tx));
  }
});
