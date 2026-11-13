'use strict';

// Verificação independente do Marco 9, rodada 8 (12/11/2026), item 2 (DI-M9R-24): a CONSULTA das rotas GET dava 500 com objeto do `qs`
// (`GET /people`, `GET /crm/feedback-cases`, `GET /feature-flags`), lista no lugar de valor (`GET /ai/release-gates`) e página finita enorme
// (`/ai/memories`, `/ai/recommendations`, `/marketing/publications`, `/marketing/templates`: OFFSET `infinity`). Agora o contrato da consulta vale
// para todas as rotas (valores em texto, lista só onde a rota declara, paginação inteira numa faixa segura) e as oito rotas têm esquema de consulta.
// Parte 1 (sem banco): a regra e a aplicação em todas as rotas. Parte 2 (HTTP real, perfil com todas as permissões): os oito casos dão 400 e as
// consultas legítimas continuam 200; e a consulta adversária do verificador, mais texto no lugar de número na paginação, em TODAS as rotas GET: 0 5xx.
process.env.PORT = process.env.ENTRADA_GLOBAL_CONSULTA_TEST_PORT || require('./marco9/_helpers/portaLivre').portaLivre();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const bcrypt = require('bcryptjs');
const { conferirConsulta, declararConsulta } = require('../src/shared/validation/queryContract');

const DISPOSABLE = process.env.DISPOSABLE_DB === '1' || Boolean(process.env.CI);
let A; let token;
const SUFIXO = `${Date.now()}${Math.floor(Math.random() * 1000)}`;

// ---------- parte 1 ----------

test('contrato: objeto nunca; lista só declarada; paginação inteira de 0 ao máximo; texto que não é número segue para a rota', () => {
  const codigo = (q, o) => { const e = conferirConsulta(q, o); return e ? [e.statusCode, e.code, e.details.fields] : null; };
  assert.deepEqual(codigo({ type: { toString: 'x' } }), [400, 'QUERY_PARAMETER_INVALID', ['type']]);
  assert.deepEqual(codigo({ kind: { __proto__: { x: 1 } } }), [400, 'QUERY_PARAMETER_INVALID', ['kind']]);
  assert.deepEqual(codigo({ status: ['A', 'B'] }), [400, 'QUERY_PARAMETER_INVALID', ['status']]);
  assert.equal(codigo({ status: ['A', 'B'] }, { listas: ['status'] }), null, 'lista declarada');
  assert.deepEqual(codigo({ status: ['A', { b: '1' }] }, { listas: ['status'] }), [400, 'QUERY_PARAMETER_INVALID', ['status']], 'lista declarada só de textos');
  assert.deepEqual(codigo({ page: ['1', '2'] }, { listas: ['page'] }), [400, 'QUERY_PARAMETER_INVALID', ['page']], 'paginação nunca é lista');
  for (const v of ['1.7976931348623157e308', '1e21', 'Infinity', '-1', '2.5', '9007199254740993', '0x10', '100000001', ' 1e3 ']) {
    assert.deepEqual(codigo({ page: v }), [400, 'QUERY_PAGINATION_INVALID', ['page']], `page=${v}`);
  }
  assert.deepEqual(codigo({ limit: '100001' }), [400, 'QUERY_PAGINATION_INVALID', ['limit']]);
  for (const q of [{ page: '0' }, { page: '100000000' }, { limit: '100000' }, { offset: '25' }, { page: 'abc' }, { pageSize: '' }, { q: 'texto', status: 'OPEN' }]) assert.equal(codigo(q), null, JSON.stringify(q));
  const e = conferirConsulta({ type: { toString: 'x' } });
  assert.ok(!JSON.stringify(e.details).includes('toString'), 'o valor não volta');
  assert.equal(declararConsulta({ listas: ['a'] }).listasDaConsulta[0], 'a');
});

test('o contrato está em TODAS as rotas do agregador, logo antes do controller; listas declaradas e as dos esquemas de consulta', () => {
  const router = require('../src/routes');
  const rotas = [];
  const pilha = [router.stack];
  while (pilha.length) for (const l of pilha.pop()) { if (l.route) rotas.push(l.route); else if (l.handle && l.handle.stack) pilha.push(l.handle.stack); }
  assert.ok(rotas.length > 800, `rotas: ${rotas.length}`);
  const sem = rotas.filter((r) => r.stack.filter((c) => c.contratoDaConsulta).length !== 1).map((r) => r.path);
  assert.deepEqual(sem, [], 'cada rota tem o contrato uma vez');
  const fora = rotas.filter((r) => { const i = r.stack.findIndex((c) => c.contratoDaConsulta); return r.stack.slice(i + 1).filter((c) => c.handle.length < 4).length !== 1; }).map((r) => r.path);
  assert.deepEqual(fora, [], 'o contrato fica logo antes do último handler');
  const listasDe = (p) => { const r = rotas.find((x) => x.path === p && x.methods.get); const camadas = r.stack.flatMap((c) => c.handle.listasDaConsulta || []); return [...new Set(camadas)].sort(); };
  assert.deepEqual(listasDe('/calendar'), ['sourceType', 'status']);
  assert.deepEqual(listasDe('/analytics/alerts'), ['status']);
  assert.deepEqual(listasDe('/people'), []);
});

// ---------- parte 2 ----------

function pedir(caminho) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let req;
    try {
      req = http.request({ host: '127.0.0.1', port: Number(process.env.PORT), method: 'GET', path: caminho, headers: { Authorization: `Bearer ${token}` } }, (res) => {
        const partes = [];
        res.on('data', (c) => partes.push(c));
        res.on('end', () => { let j = null; try { j = JSON.parse(Buffer.concat(partes).toString('utf8')); } catch (_e) { j = null; } resolve({ status: res.statusCode, code: j && j.error ? j.error.code : null, ms: Date.now() - t0 }); });
      });
    } catch (e) { resolve({ status: -1, code: e.code, ms: 0 }); return; }
    req.setTimeout(20000, () => req.destroy(new Error('sem resposta em 20 s')));
    req.on('error', (e) => resolve({ status: 0, code: e.message, ms: Date.now() - t0 }));
    req.end();
  });
}

before(async () => {
  if (!DISPOSABLE || !process.env.CI_TENANT_USERS_PASSWORD) return;
  const env = require('./marco9/_helpers/m9d230Env');
  const { User, UserMembership, Role, Permission, RolePermission } = require('../src/models');
  A = (await env.carregarTenants()).tenant;
  env.useTempSecretStore();
  for (const [k, v] of [['governanca.api.rate_limit.habilitado', false], ['ia.habilitada', true], ['ai.agents.enabled', '*']]) await env.parametro(A, k, v);
  const ps = await Permission.findAll();
  const email = `ci-consulta-${SUFIXO}@ci.nayaraone.test`;
  const user = await User.create({ name: 'CI consulta', email, passwordHash: await bcrypt.hash(process.env.CI_TENANT_USERS_PASSWORD, 10), status: 'ACTIVE' });
  await env.comTenant(A, async (t) => {
    const role = await Role.create({ groupId: A.groupId, companyId: A.companyId, name: `CI CONSULTA ${SUFIXO}`, description: 'Perfil fictício do teste da consulta (todas as permissões).', isSystem: false }, { transaction: t });
    for (const p of ps) await RolePermission.create({ roleId: role.id, permissionId: p.id }, { transaction: t });
    await UserMembership.create({ userId: user.id, groupId: A.groupId, companyId: A.companyId, roleId: role.id, status: 'ACTIVE' }, { transaction: t });
  });
  await new Promise((s) => setTimeout(s, 300));
  for (let i = 0; i < 5 && !token; i += 1) {
    const r = await fetch(`http://127.0.0.1:${process.env.PORT}/api/v1/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: process.env.CI_TENANT_USERS_PASSWORD, companyId: A.companyId }) });
    if (r.status === 200) token = (await r.json()).data.accessToken; else await new Promise((s) => setTimeout(s, 300 * (i + 1)));
  }
});

after(async () => {
  if (A) await require('./marco9/_helpers/m9d230Env').restaurar(A, ['governanca.api.rate_limit.habilitado', 'ia.habilitada', 'ai.agents.enabled']).catch(() => {});
  if (DISPOSABLE) { await require('../src/models').sequelize.close().catch(() => {}); process.exit(0); }
});

const PRECISA = () => (DISPOSABLE && token ? false : 'precisa do banco descartável (node scripts/withDisposableDb.js) e de CI_TENANT_USERS_PASSWORD');

test('os oito casos da rodada 8 dão 400 (antes: 500); as consultas legítimas continuam 200', { timeout: 120000 }, async (t) => {
  if (PRECISA()) { t.skip(PRECISA()); return; }
  const casos = [
    ['/people?status[a]=1&type[toString]=x', 'PERSON_VALIDATION'],
    ['/crm/feedback-cases?type[toString]=x&status[a]=1', 'FEEDBACK_CASE_VALIDATION'],
    ['/feature-flags?kind[__proto__][r8polluted]=1', 'GOV_FLAG_INPUT_INVALID', 422],
    ['/feature-flags?kind=QUALQUER', 'GOV_FLAG_INPUT_INVALID', 422],
    ['/ai/release-gates?status[]=A&status[]=B', 'AI_GATE_INVALID'],
    ['/ai/memories?page=1.7976931348623157e308', 'AI_MEMORY_INVALID'],
    ['/ai/recommendations?page=1.7976931348623157e308', 'AI_RECOMMENDATION_INVALID'],
    ['/marketing/publications?page=1.7976931348623157e308', 'MKT_VALIDATION'],
    ['/marketing/templates?page=1.7976931348623157e308', 'VALIDATION_ERROR'],
  ];
  for (const [caminho, codigo, status = 400] of casos) {
    const r = await pedir(`/api/v1${caminho}`);
    assert.deepEqual([r.status, r.code], [status, codigo], caminho);
  }
  // o contrato geral pega a mesma forma nas rotas sem esquema de consulta
  for (const caminho of ['/finance/entries?page=1.7976931348623157e308', '/inventory/items?status[a]=1', '/opportunities?personId[length]=3', '/legal/clauses?limit=1e21']) {
    const r = await pedir(`/api/v1${caminho}`);
    assert.equal(r.status, 400, caminho);
    assert.ok(['QUERY_PAGINATION_INVALID', 'QUERY_PARAMETER_INVALID'].includes(r.code), `${caminho}: ${r.code}`);
  }
  for (const caminho of ['/people?personType=PF', '/crm/feedback-cases?status=OPEN&overdue=true', '/feature-flags?kind=flag', '/ai/release-gates?status=APPROVED',
    '/ai/memories?page=2&limit=5', '/ai/recommendations?page=1&limit=10', '/marketing/publications?page=1&pageSize=10', '/marketing/templates?page=1&pageSize=10',
    '/calendar?status=OPEN&status=DONE', '/analytics/alerts?status=OPEN&status=ACKNOWLEDGED']) {
    const r = await pedir(`/api/v1${caminho}`);
    assert.equal(r.status, 200, `${caminho}: ${r.status} ${r.code}`);
  }
});

test('todas as rotas GET com a consulta adversária do verificador e paginação em texto: nenhuma 5xx, nenhuma sem resposta, nenhuma acima de 2 s', { timeout: 1800000 }, async (t) => {
  if (PRECISA()) { t.skip(PRECISA()); return; }
  const { gerar } = require('../scripts/gerarMatrizPermissoes');
  const PULAR = [/\/mfa\b/i, /\/auth\/(logout|switch|refresh)/, /\/users\/me\/(password|mfa)/];
  const rotas = gerar().filter((r) => r.method === 'GET' && !PULAR.some((re) => re.test(r.path)));
  const caminho = (p) => p.split('/').map((s) => (s.startsWith(':') ? (/key|code|slug|name|provider|type|token|channel/i.test(s) ? 'x' : '00000000-0000-4000-8000-0000000000aa') : s)).join('/');
  const CONSULTAS = [
    'page=1.7976931348623157e308&limit=1.7976931348623157e308&pageSize=1e21&offset=1e21',
    'page=9007199254740993&limit=-9007199254740993&offset=-1&pageSize=0',
    'page=abc&limit=abc&offset=abc&pageSize=abc&perPage=abc',
    'from=infinity&to=-infinity&dateFrom=now&dateTo=epoch&period=infinity&referenceMonth=infinity&competenceMonth=now',
    'from=2026-02-30&to=294277-01-01&period=2026-13&referenceMonth=2026-00&competenceMonth=20261&referenceYear=1e21',
    'personId=%7B00000000-0000-4000-8000-000000000001%7D&propertyId=00000000000040008000000000000001&userId=00000000-0000-4000-8000-00000000000g',
    'status[]=A&status[]=B&type[]=x&personId[]=00000000-0000-4000-8000-000000000001&personId[]=x&limit[]=1&page[]=2&from[]=2026-01-01&period[]=1',
    'status[a]=1&type[toString]=x&personId[length]=3&limit[valueOf]=1&period[gte]=2026-01-01&from[$gt]=1&kind[__proto__][r8polluted]=1',
    'isActive=talvez&overdue=2&pending=null&include=__proto__&asTree=1e21&download=sim&format=xml&windowDays=1e21&thresholdDays=-1e21',
    'cursor=%FF%FE&sortBy=__proto__&order=DESC;DROP&orderBy=constructor&sort=-1e21',
  ];
  const ruins = [];
  let total = 0;
  for (const r of rotas) {
    for (const q of CONSULTAS) {
      const res = await pedir(`${caminho(r.path)}?${q}`);
      total += 1;
      const desligado = res.status === 503 && /_DISABLED$|_NOT_CONFIGURED$/.test(String(res.code));
      if ((res.status >= 500 && !desligado) || res.status === 0 || res.ms >= 2000) ruins.push(`GET ${r.path}?${q.slice(0, 40)} -> ${res.status} ${res.code || ''} (${res.ms} ms)`);
    }
  }
  console.log(`ENTRADA_GLOBAL_CONSULTA ${rotas.length} rotas GET, ${total} pedidos, ${ruins.length} fora do esperado`);
  assert.deepEqual(ruins, []);
  assert.equal(({}).r8polluted, undefined, 'o protótipo continua intacto');
});
