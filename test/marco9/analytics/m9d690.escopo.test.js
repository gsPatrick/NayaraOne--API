'use strict';

// M9-D690 — escopo, permissão e filtro assinado do detalhe: cross-company é 404, sem permissão só o agregado, filtro forjado é 400.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env690 = require('../_helpers/m9d690Env');
const security = require('../../../src/features/analytics/security');

let env;
before(async () => { env = await env690.setup(); });
after(() => env690.teardown(env));

const m = (key) => env.metrics.find((x) => x.key === key);

test('m9d690 cross-company detail é bloqueado com 404', async () => {
  const fin = m('fin');
  const ref = await env690.refOf(env, fin);
  // a sessão é da empresa B e pede o detalhe da empresa A
  const res = await env690.get(env, fin, ref, { tenant: 'B', extra: { companyId: env.tenantA.companyId } });
  assert.equal(res.status, 404);
  assert.equal(res.body.error.code, 'ANALYTICS_SCOPE_NOT_FOUND');
  assert.equal(res.body.error.message, 'Empresa não encontrada ou sem acesso.');
  // empresa que não existe: a mesma resposta, sem revelar existência
  const ghost = await env690.get(env, fin, ref, { extra: { companyId: '00000000-0000-4000-8000-000000000000' } });
  assert.equal(ghost.status, 404);
  assert.equal(ghost.body.error.code, 'ANALYTICS_SCOPE_NOT_FOUND');
  // filtro assinado para a empresa A levado por quem é da empresa B: nunca devolve linha
  const stolen = await env690.get(env, fin, ref, { tenant: 'B' });
  assert.ok([400, 404].includes(stolen.status), `status ${stolen.status}`);
  assert.equal(stolen.body.data, undefined);
});

test('m9d690 drill-down sem permissão é bloqueado e devolve só o agregado', async () => {
  const legal = m('legal');
  const ref = await env690.refOf(env, legal);
  const res = await env690.get(env, legal, ref, { perms: ['analytics:read', 'analytics:drilldown'] }); // sem legal:read
  assert.equal(res.status, 403);
  assert.equal(res.body.error.code, 'ANALYTICS_DRILLDOWN_FORBIDDEN');
  assert.equal(res.body.error.message, 'Você não tem permissão para ver o detalhe deste indicador.');
  assert.deepEqual(res.body.error.details.aggregate, { count: env690.INSIDE.length, total: null });
  assert.equal(res.body.data, undefined);
  assert.ok(!JSON.stringify(res.body).includes('Maria'), 'nenhum dado de linha vaza');
  const fin = m('fin');
  const finRes = await env690.get(env, fin, await env690.refOf(env, fin), { perms: ['analytics:read', 'analytics:drilldown'] });
  assert.equal(finRes.status, 403);
  assert.deepEqual(finRes.body.error.details.aggregate, { count: env690.INSIDE.length, total: String(env690.sumSigned(env690.INSIDE).toFixed(2)) }, 'o agregado monetário vem no sinal da origem');
  const noRead = await env.call('GET', `/analytics/metrics/${legal.code}/drilldown?${env690.query(ref)}`, { perms: ['legal:read', 'analytics:drilldown'] });
  assert.equal(noRead.status, 403);
  assert.equal(noRead.body.error.code, 'PERMISSION_DENIED');
});

test('m9d690 usuário com permissão de domínio mas sem analytics:drilldown é bloqueado', async () => {
  const legal = m('legal');
  const ref = await env690.refOf(env, legal);
  const res = await env690.get(env, legal, ref, { perms: ['analytics:read', 'legal:read'] });
  assert.equal(res.status, 403);
  assert.equal(res.body.error.code, 'ANALYTICS_DRILLDOWN_FORBIDDEN');
  assert.equal(res.body.error.details.aggregate.count, env690.INSIDE.length);
  assert.equal(res.body.data, undefined);
  const both = await env690.get(env, legal, ref);
  assert.equal(both.status, 200, 'com as duas permissões o detalhe abre');
});

test('m9d690 filterHash forjado é recusado', async () => {
  const legal = m('legal');
  const ref = await env690.refOf(env, legal);
  const bad = (r) => r.status === 400 && r.body.error.code === 'ANALYTICS_FILTER_HASH_INVALID' && r.body.error.message === 'Filtro de detalhe inválido.';
  assert.ok(bad(await env690.get(env, legal, { ...ref, filterHash: '0'.repeat(64) })));
  assert.ok(bad(await env690.get(env, legal, { ...ref, filterSignature: 'a'.repeat(64) })));
  const wider = { ...ref.filter, period: { from: '2025-01-01T03:00:00.000Z', to: '2027-01-01T03:00:00.000Z' } };
  assert.ok(bad(await env690.get(env, legal, { ...ref, filter: wider })), 'filtro mais amplo com o hash do filtro autorizado');
  assert.ok(bad(await env690.get(env, legal, { ...ref, filter: wider, filterHash: require('../../../src/features/analytics/metrics').hashFilter(ref.table, wider) })), 'hash recalculado sem a chave do servidor');
  const noFilter = await env.call('GET', `/analytics/metrics/${legal.code}/drilldown?filterHash=${ref.filterHash}&filterSignature=${ref.filterSignature}`, { perms: env690.ADMIN_PERMS(legal) });
  assert.ok(bad(noFilter));
  const junk = await env.call('GET', `/analytics/metrics/${legal.code}/drilldown?filter=%7Bnao-json&filterHash=${ref.filterHash}&filterSignature=${ref.filterSignature}`, { perms: env690.ADMIN_PERMS(legal) });
  assert.ok(bad(junk));
  // adulterado, sem a permissão: continua 400 (a verificação do filtro vem antes da permissão)
  assert.ok(bad(await env690.get(env, legal, { ...ref, filterHash: '1'.repeat(64) }, { perms: ['analytics:read'] })));
});

test('m9d690 mapa domínio-permissão usa marketing:attribution:read para Marketing e crm:read para Atendimento', async () => {
  const map = security.mergeDomainMap(undefined);
  assert.equal(security.domainPermissionOf(map, 'MARKETING'), 'marketing:attribution:read');
  assert.equal(security.domainPermissionOf(map, 'SUPPORT'), 'crm:feedback:read', 'crm:read não existe no projeto; a permissão real de ocorrências e pesquisas é crm:feedback:read (DI-D690-1)');
  assert.equal(security.domainPermissionOf(map, 'FINANCE'), 'finance:read');
  assert.equal(security.domainPermissionOf(map, 'LEGAL'), 'legal:read');
  assert.equal(security.domainPermissionOf(map, 'RENTAL'), 'legal:read', 'a locação vive no módulo de contratos/jurídico');
  assert.equal(security.domainPermissionOf(map, 'CONSTRUCTION'), 'construction:read');
  assert.equal(security.domainPermissionOf(map, 'INVENTORY'), 'inventory:read');
  assert.equal(security.domainPermissionOf(map, 'CORRESPONDENT'), 'correspondent:read');
  assert.equal(security.domainPermissionOf(map, 'TECH_AI'), 'analytics:read:tech');
  assert.equal(security.domainPermissionOf(map, 'CRM'), 'crm:opportunities:read');
  // na rota: Marketing abre com a permissão de atribuição e não com a de oportunidades
  const mkt = m('mkt');
  const ref = await env690.refOf(env, mkt);
  const wrong = await env690.get(env, mkt, ref, { perms: ['analytics:read', 'analytics:drilldown', 'crm:opportunities:read'] });
  assert.equal(wrong.status, 403);
  assert.equal((await env690.get(env, mkt, ref)).status, 200);
  const sup = m('sup');
  const supRef = await env690.refOf(env, sup);
  assert.equal((await env690.get(env, sup, supRef, { perms: ['analytics:read', 'analytics:drilldown', 'crm:feedback:read'] })).status, 200);
  assert.equal((await env690.get(env, sup, supRef, { perms: ['analytics:read', 'analytics:drilldown', 'crm:opportunities:read'] })).status, 403);
});
