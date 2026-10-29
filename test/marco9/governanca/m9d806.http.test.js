'use strict';

// M9-D806 — GET /data-quality pela API real (banco descartável): permissão, filtros, paginação, resumo e isolamento entre empresas.
process.env.PORT = process.env.M9D806_HTTP_TEST_PORT || '21656';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d806Env');
const { startHttp, stopHttp } = require('../_helpers/m9d806Http');
const { withTenantTransaction } = require('../../testHelpers');
const { evaluateEntity } = require('../../../src/features/core-governance/data-quality/quality.evaluate');

const GRANTS = { 'CI LEITURA': ['governance:data-quality:read'], 'CI GESTOR': ['governance:data-quality:read', 'governance:data-quality:manage'] };
let http;
before(async () => { http = await startHttp({ port: process.env.PORT, grants: GRANTS, logins: { leituraA: ['A', 'leitura'], semA: ['A', 'maker'], leituraB: ['B', 'leitura'] } }); });
after(async () => { await stopHttp(GRANTS); });

test('m9d806 GET /data-quality: 403 sem a permissão de leitura', async (t) => {
  if (http.skip) return t.skip(http.skip);
  const denied = await http.call('semA', 'GET', '/data-quality');
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error.code, 'PERMISSION_DENIED');
  assert.equal(denied.body.error.details.required, 'governance:data-quality:read');
});

test('m9d806 GET /data-quality filtra, pagina e resume; empresa B não vê dados da A', async (t) => {
  if (http.skip) return t.skip(http.skip);
  const { tenants } = http;
  const { person, supplier } = await withTenantTransaction(tenants.A, async (tx) => {
    const p = await env.fullPerson(tenants.A, tx, { legalName: 'Qualidade Http Conferida' }, { contact: false });
    const s = await env.fullSupplier(tenants.A, tx, { taxIdNormalized: env.invalidCnpj() });
    await evaluateEntity(tenants.A, 'PERSON', p.id, tx, { actorUserId: tenants.A.userId });
    await evaluateEntity(tenants.A, 'SUPPLIER', s.id, tx, { actorUserId: tenants.A.userId });
    return { person: p, supplier: s };
  });
  const all = await http.call('leituraA', 'GET', '/data-quality?pageSize=200');
  assert.equal(all.status, 200, JSON.stringify(all.body));
  const { summary, items } = all.body.data;
  assert.deepEqual(Object.keys(summary).sort(), ['avgScore', 'avgScoreByDomain', 'domainsWithoutOwner', 'openIssues']);
  assert.deepEqual(Object.keys(summary.avgScoreByDomain).sort(), ['FORNECEDORES', 'IMOVEIS', 'PESSOAS']);
  assert.ok(items.some((i) => i.entityId === person.id && i.score === 85 && i.issues[0].ruleCode === 'PERSON_CONTACT_PRESENT'));
  assert.equal(all.body.pagination.pageSize, 200);
  const critical = await http.call('leituraA', 'GET', '/data-quality?severity=CRITICAL&entityType=SUPPLIER&pageSize=200');
  assert.ok(critical.body.data.items.some((i) => i.entityId === supplier.id));
  assert.ok(critical.body.data.items.every((i) => i.entityType === 'SUPPLIER'));
  const one = await http.call('leituraA', 'GET', '/data-quality?pageSize=1&page=1');
  assert.equal(one.body.data.items.length, 1);
  assert.ok(one.body.pagination.total >= 2);
  const bad = await http.call('leituraA', 'GET', '/data-quality?domain=FINANCEIRO');
  assert.deepEqual([bad.status, bad.body.error.code, bad.body.error.message], [400, 'GOV_DQ_FILTER_INVALID', 'Filtro de qualidade inválido.']);
  const other = await http.call('leituraB', 'GET', '/data-quality?pageSize=200');
  assert.equal(other.status, 200);
  assert.ok(!other.body.data.items.some((i) => [person.id, supplier.id].includes(i.entityId)));
});
