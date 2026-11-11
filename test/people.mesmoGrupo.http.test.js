'use strict';

// Isolamento de Pessoas entre DUAS empresas do MESMO grupo, pelo caminho HTTP real (login com senha, JWT, auth, tenant
// middleware e RLS), reproduzindo o achado ao vivo da homologação em 10/11/2026: o mesmo usuário com vínculo nas duas
// empresas do grupo entra na empresa B (POST /auth/login com companyId) e tenta ler e gravar a pessoa criada na empresa A.
// Antes da migration 20260101009965: GET por id 200, consentimentos 200, a lista trazia as pessoas de A e o POST de
// consentimento dava 500. Agora: 404 limpo em tudo e lista sem as pessoas de A; o fluxo dentro de cada empresa segue.
//
// GRAVA de verdade (empresa, papel, usuário e pessoas): só roda em banco descartável (DISPOSABLE_DB=1, dado por
// scripts/withDisposableDb.js) ou no CI, depois do seed de dois tenants. Fora disso o teste é PULADO com o motivo.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');

const { TENANTS } = require('../scripts/seed-ci-two-tenants');
const { sequelize, Group, Company, User, UserMembership, Role, Permission, RolePermission } = require('../src/models');

process.env.PORT = process.env.PEOPLE_SAME_GROUP_HTTP_TEST_PORT || '21681';

const PERMISSOES = ['people:read', 'people:create', 'people:update', 'people:delete', 'crm:messages:read'];
const SUFIXO = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const EMAIL = `ci-mesmo-grupo-${SUFIXO}@ci.nayaraone.test`;

let skipReason = null;
let appLoaded = false;
let baseUrl;
let empresaA;
let empresaB;
const tokens = {};

function randomCpf() {
  const n = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10));
  const dv = (arr) => { const f = arr.length + 1; const r = (arr.reduce((acc, d, i) => acc + d * (f - i), 0) * 10) % 11; return r === 10 ? 0 : r; };
  n.push(dv(n)); n.push(dv(n));
  return n.join('');
}

/** Vínculo do usuário numa empresa, com papel próprio daquela empresa (papéis são por empresa). */
async function vincular(user, groupId, companyId, permissoes) {
  await sequelize.transaction(async (transaction) => {
    await sequelize.query("SELECT set_config('app.group_id', :g, true), set_config('app.company_id', :c, true)", { replacements: { g: groupId, c: companyId }, transaction });
    const role = await Role.create({ groupId, companyId, name: `CI MESMO GRUPO ${SUFIXO}`, description: 'Perfil fictício do teste de isolamento no mesmo grupo.', isSystem: false }, { transaction });
    for (const p of permissoes) await RolePermission.create({ roleId: role.id, permissionId: p.id }, { transaction });
    await UserMembership.create({ userId: user.id, groupId, companyId, roleId: role.id, status: 'ACTIVE' }, { transaction });
  });
}

async function entrar(companyId) {
  let res; let body;
  for (let tentativa = 0; tentativa < 5; tentativa += 1) {
    res = await fetch(`${baseUrl}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: EMAIL, password: process.env.CI_TENANT_USERS_PASSWORD, companyId }) });
    body = await res.json();
    if (res.status !== 409) break;
    await new Promise((resolve) => setTimeout(resolve, 200 * (tentativa + 1)));
  }
  assert.equal(res.status, 200, `login na empresa ${companyId} deveria funcionar: ${JSON.stringify(body)}`);
  return body.data.accessToken;
}

before(async () => {
  if (process.env.DISPOSABLE_DB !== '1' && !process.env.CI) { skipReason = 'Grava dados: só roda em banco descartável (scripts/withDisposableDb.js) ou no CI.'; return; }
  if (!process.env.CI_TENANT_USERS_PASSWORD) { skipReason = 'CI_TENANT_USERS_PASSWORD ausente (senha dos usuários fictícios do CI).'; return; }
  const group = await Group.findOne({ where: { name: TENANTS[0].groupName } });
  if (!group) { skipReason = 'Grupo do seed de dois tenants ausente: rode scripts/seed-ci-two-tenants.js.'; return; }
  const permissoes = await Permission.findAll({ where: { code: PERMISSOES } });
  assert.equal(permissoes.length, PERMISSOES.length, `permissões ausentes do catálogo: ${PERMISSOES.filter((c) => !permissoes.some((p) => p.code === c))}`);

  await sequelize.transaction(async (transaction) => {
    await sequelize.query("SELECT set_config('app.group_id', :g, true)", { replacements: { g: group.id }, transaction });
    empresaA = await Company.findOne({ where: { groupId: group.id, name: TENANTS[0].companyName }, transaction });
    empresaB = await Company.create({ groupId: group.id, name: `CI — Empresa do mesmo grupo ${SUFIXO}`, status: 'ACTIVE' }, { transaction });
  });
  assert.ok(empresaA, 'empresa A do seed CI não encontrada');
  const user = await User.create({ name: `CI mesmo grupo ${SUFIXO}`, email: EMAIL, passwordHash: await bcrypt.hash(process.env.CI_TENANT_USERS_PASSWORD, 10), status: 'ACTIVE' });
  await vincular(user, group.id, empresaA.id, permissoes);
  await vincular(user, group.id, empresaB.id, permissoes);

  require('../app');
  appLoaded = true;
  baseUrl = `http://127.0.0.1:${process.env.PORT}/api/v1`;
  await new Promise((resolve) => setTimeout(resolve, 300));
  tokens.A = await entrar(empresaA.id);
  tokens.B = await entrar(empresaB.id);
});

after(async () => {
  await sequelize.close().catch(() => {});
  if (appLoaded) process.exit(0);
});

async function call(quem, method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens[quem]}` }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function pessoaComConsentimento(quem, nome, taxIdNormalized) {
  const p = await call(quem, 'POST', '/people', { personType: 'PF', legalName: nome, taxIdNormalized });
  assert.equal(p.status, 201, JSON.stringify(p.body));
  const c = await call(quem, 'POST', `/people/${p.body.data.id}/consents`, { channel: 'EMAIL', purpose: 'MARKETING', status: 'OPT_IN' });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  return p.body.data;
}

test('HTTP mesmo grupo: os tokens das duas entradas apontam para empresas diferentes do mesmo grupo', (t) => {
  if (skipReason) return t.skip(skipReason);
  const claims = (tok) => JSON.parse(Buffer.from(tok.split('.')[1], 'base64').toString());
  assert.equal(claims(tokens.A).group_id, claims(tokens.B).group_id, 'as duas empresas são do MESMO grupo');
  assert.equal(claims(tokens.A).company_id, empresaA.id);
  assert.equal(claims(tokens.B).company_id, empresaB.id);
});

test('HTTP mesmo grupo: empresa B não lê nem grava a pessoa da empresa A (404 limpo, nunca 500) e nada é gravado em A', async (t) => {
  if (skipReason) return t.skip(skipReason);
  const pessoaA = await pessoaComConsentimento('A', `Pessoa A mesmo grupo ${SUFIXO}`, randomCpf());
  const id = pessoaA.id;
  const casos = [
    ['GET', `/people/${id}`],
    ['GET', `/people/${id}/consents`],
    ['GET', `/people/${id}/contacts`],
    ['GET', `/people/${id}/addresses`],
    ['GET', `/people/${id}/documents`],
    ['GET', `/people/${id}/roles`],
    ['POST', `/people/${id}/consents`, { channel: 'PHONE', purpose: 'ISOLAMENTO', status: 'OPT_IN' }],
    ['POST', `/people/${id}/contacts`, { contactType: 'EMAIL', valueNormalized: `invasor${SUFIXO}@exemplo.test` }],
    ['PATCH', `/people/${id}`, { preferredName: 'Invasor' }],
    ['DELETE', `/people/${id}`],
  ];
  for (const [metodo, rota, corpo] of casos) {
    const r = await call('B', metodo, rota, corpo);
    assert.equal(r.status, 404, `${metodo} ${rota} pela empresa B deveria dar 404: ${r.status} ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error.code, 'PERSON_NOT_FOUND', `${metodo} ${rota}: código inesperado ${r.body.error.code}`);
  }

  const listaB = await call('B', 'GET', '/people');
  assert.equal(listaB.status, 200);
  assert.ok(!listaB.body.data.some((p) => p.id === id || p.companyId !== empresaB.id), 'a lista da empresa B não pode trazer pessoa de outra empresa');
  const msgs = await call('B', 'GET', `/messages?personId=${id}`);
  assert.equal(msgs.status, 200, JSON.stringify(msgs.body));
  const itens = Array.isArray(msgs.body.data) ? msgs.body.data : (msgs.body.data && msgs.body.data.items) || [];
  assert.equal(itens.length, 0, 'mensagens da pessoa de A não podem aparecer para B');

  const daA = await call('A', 'GET', `/people/${id}`);
  assert.equal(daA.status, 200);
  assert.equal(daA.body.data.preferredName, null, 'a pessoa de A não pode ter sido alterada por B');
  const consA = await call('A', 'GET', `/people/${id}/consents`);
  assert.equal(consA.body.data.length, 1, 'nenhum consentimento novo pode ter entrado em A');
  const contA = await call('A', 'GET', `/people/${id}/contacts`);
  assert.equal(contA.body.data.length, 0, 'nenhum contato pode ter entrado em A');
});

test('HTTP mesmo grupo: o mesmo CPF na empresa B é recusado com 409 sem entregar a pessoa de A', async (t) => {
  if (skipReason) return t.skip(skipReason);
  const cpf = randomCpf();
  await pessoaComConsentimento('A', `Pessoa A CPF ${SUFIXO}`, cpf);
  const r = await call('B', 'POST', '/people', { personType: 'PF', legalName: 'Mesmo CPF em B', taxIdNormalized: cpf });
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.error.code, 'PERSON_DUPLICATE_TAX_ID');
  assert.ok(!JSON.stringify(r.body).includes('existingPersonId'), 'a recusa não pode entregar o id da pessoa da empresa A');
});

test('HTTP mesmo grupo: fluxo legítimo intacto em cada empresa e A também não vê a pessoa de B', async (t) => {
  if (skipReason) return t.skip(skipReason);
  const pessoaB = await pessoaComConsentimento('B', `Pessoa B mesmo grupo ${SUFIXO}`);
  const lida = await call('B', 'GET', `/people/${pessoaB.id}`);
  assert.equal(lida.status, 200);
  assert.equal(lida.body.data.companyId, empresaB.id);
  const edit = await call('B', 'PATCH', `/people/${pessoaB.id}`, { preferredName: 'Nome de uso B' });
  assert.equal(edit.status, 200, JSON.stringify(edit.body));
  const cons = await call('B', 'GET', `/people/${pessoaB.id}/consents`);
  assert.equal(cons.status, 200);
  assert.equal(cons.body.data.length, 1);
  const listaB = await call('B', 'GET', '/people');
  assert.ok(listaB.body.data.some((p) => p.id === pessoaB.id));

  const deA = await call('A', 'GET', `/people/${pessoaB.id}`);
  assert.equal(deA.status, 404, 'a empresa A também não lê a pessoa da empresa B');
  const listaA = await call('A', 'GET', '/people');
  assert.ok(listaA.body.data.every((p) => p.companyId === empresaA.id), 'a lista de A só traz pessoas de A');
});
