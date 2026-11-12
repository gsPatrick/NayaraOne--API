'use strict';

// Isolamento das rotas de MENSAGEM entre duas empresas do MESMO grupo, pelo caminho HTTP real (login com senha, JWT, auth,
// tenant middleware e RLS). Achado ISO-R2 da verificação independente de 12/11/2026: a empresa B chamando
// POST /messages/:id/send-alternate sobre a mensagem da empresa A (ou sobre um id inexistente) recebia 409
// INTEGRATION_MESSAGING_ALTERNATE_NOT_APPLICABLE, porque "não encontrada" era tratada como "não está na fila".
// Regra: mensagem fora do escopo de quem chama dá 404 MESSAGE_NOT_FOUND, o mesmo código de GET, PATCH status e
// refresh-status; o 409 continua só para a mensagem que existe na empresa e de fato não se aplica. Na mesma varredura,
// POST /messages/send com a pessoa de outra empresa dava 403 "sem consentimento" (ou o erro de conexão): agora 404 PERSON_NOT_FOUND.
//
// GRAVA de verdade (empresa, papel, usuário, pessoa e mensagem): só roda em banco descartável (DISPOSABLE_DB=1, dado por
// scripts/withDisposableDb.js) ou no CI, depois do seed de dois tenants. Fora disso o teste é PULADO com o motivo.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');

const { TENANTS } = require('../scripts/seed-ci-two-tenants');
const { sequelize, Group, Company, User, UserMembership, Role, Permission, RolePermission } = require('../src/models');

process.env.PORT = process.env.CRM_MESSAGES_SAME_GROUP_HTTP_TEST_PORT || '21682';

const PERMISSOES = ['people:read', 'people:create', 'crm:messages:read', 'crm:messages:create', 'crm:messages:update'];
const SUFIXO = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const EMAIL = `ci-msg-mesmo-grupo-${SUFIXO}@ci.nayaraone.test`;

let skipReason = null;
let appLoaded = false;
let baseUrl;
let empresaA;
let empresaB;
const tokens = {};

/** Vínculo do usuário numa empresa, com papel próprio daquela empresa (papéis são por empresa). */
async function vincular(user, groupId, companyId, permissoes) {
  await sequelize.transaction(async (transaction) => {
    await sequelize.query("SELECT set_config('app.group_id', :g, true), set_config('app.company_id', :c, true)", { replacements: { g: groupId, c: companyId }, transaction });
    const role = await Role.create({ groupId, companyId, name: `CI MSG MESMO GRUPO ${SUFIXO}`, description: 'Perfil fictício do teste de isolamento de mensagens.', isSystem: false }, { transaction });
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
    empresaB = await Company.create({ groupId: group.id, name: `CI — Empresa de mensagens do mesmo grupo ${SUFIXO}`, status: 'ACTIVE' }, { transaction });
  });
  assert.ok(empresaA, 'empresa A do seed CI não encontrada');
  const user = await User.create({ name: `CI msg mesmo grupo ${SUFIXO}`, email: EMAIL, passwordHash: await bcrypt.hash(process.env.CI_TENANT_USERS_PASSWORD, 10), status: 'ACTIVE' });
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

/** Pessoa e uma mensagem do histórico dela na empresa A (recebida do cliente: existe, mas não está na fila do WhatsApp). */
async function mensagemDeA() {
  const p = await call('A', 'POST', '/people', { personType: 'PF', legalName: `Pessoa A mensagens ${SUFIXO}` });
  assert.equal(p.status, 201, JSON.stringify(p.body));
  const m = await call('A', 'POST', '/messages', { personId: p.body.data.id, channel: 'WHATSAPP', direction: 'INBOUND', authorType: 'CLIENT', body: `Olá, quero saber do meu boleto ${SUFIXO}` });
  assert.equal(m.status, 201, JSON.stringify(m.body));
  return { personId: p.body.data.id, message: m.body.data };
}

const esperar404 = (r, rotulo, code) => {
  assert.equal(r.status, 404, `${rotulo} deveria dar 404: ${r.status} ${JSON.stringify(r.body)}`);
  assert.equal(r.body.error.code, code, `${rotulo}: código inesperado ${r.body.error.code}`);
};

test('HTTP mesmo grupo: send-alternate da empresa B sobre a mensagem de A, ou sobre id inexistente, dá 404 MESSAGE_NOT_FOUND como as outras rotas de mensagem', async (t) => {
  if (skipReason) return t.skip(skipReason);
  const { message } = await mensagemDeA();
  const inexistente = crypto.randomUUID();

  // As outras rotas de mensagem já respondem 404 MESSAGE_NOT_FOUND fora do escopo: é o código de referência.
  esperar404(await call('B', 'GET', `/messages/${message.id}`), 'GET /messages/:id de A pela empresa B', 'MESSAGE_NOT_FOUND');
  esperar404(await call('B', 'POST', `/messages/${message.id}/refresh-status`), 'refresh-status de A pela empresa B', 'MESSAGE_NOT_FOUND');
  esperar404(await call('B', 'PATCH', `/messages/${message.id}/status`, { status: 'READ' }), 'PATCH status de A pela empresa B', 'MESSAGE_NOT_FOUND');

  esperar404(await call('B', 'POST', `/messages/${message.id}/send-alternate`), 'send-alternate da mensagem de A pela empresa B', 'MESSAGE_NOT_FOUND');
  esperar404(await call('B', 'POST', `/messages/${inexistente}/send-alternate`), 'send-alternate de id inexistente pela empresa B', 'MESSAGE_NOT_FOUND');
  esperar404(await call('A', 'POST', `/messages/${inexistente}/send-alternate`), 'send-alternate de id inexistente pela empresa A', 'MESSAGE_NOT_FOUND');

  // Nada mudou na mensagem de A.
  const daA = await call('A', 'GET', `/messages/${message.id}`);
  assert.equal(daA.status, 200, JSON.stringify(daA.body));
  assert.equal(daA.body.data.status, message.status);
  assert.equal(daA.body.data.alternateChannel ?? null, null, 'a mensagem de A não pode ter seguido por canal alternativo');
});

test('HTTP mesmo grupo: o 409 INTEGRATION_MESSAGING_ALTERNATE_NOT_APPLICABLE continua só para a mensagem que existe na empresa e não está na fila', async (t) => {
  if (skipReason) return t.skip(skipReason);
  const { message } = await mensagemDeA();
  const r = await call('A', 'POST', `/messages/${message.id}/send-alternate`);
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.error.code, 'INTEGRATION_MESSAGING_ALTERNATE_NOT_APPLICABLE');
  assert.equal(r.body.error.message, 'Só a mensagem de texto que está na fila do WhatsApp pode seguir pelo canal alternativo.');
});

test('HTTP mesmo grupo: POST /messages/send com a pessoa de A (ou inexistente) pela empresa B dá 404 PERSON_NOT_FOUND, nunca "sem consentimento"', async (t) => {
  if (skipReason) return t.skip(skipReason);
  const { personId } = await mensagemDeA();
  const corpo = (id) => ({ kind: 'text', personId: id, to: '+5511999990000', text: 'Mensagem que não pode sair.' });
  esperar404(await call('B', 'POST', '/messages', { personId, channel: 'WHATSAPP', direction: 'OUTBOUND', authorType: 'EMPLOYEE', body: 'x' }), 'POST /messages com a pessoa de A pela empresa B', 'PERSON_NOT_FOUND');
  esperar404(await call('B', 'POST', '/messages/send', corpo(personId)), 'POST /messages/send com a pessoa de A pela empresa B', 'PERSON_NOT_FOUND');
  esperar404(await call('B', 'POST', '/messages/send', corpo(crypto.randomUUID())), 'POST /messages/send com pessoa inexistente', 'PERSON_NOT_FOUND');
  const msgsB = await call('B', 'GET', `/messages?personId=${personId}`);
  assert.equal(msgsB.status, 200);
  const itens = Array.isArray(msgsB.body.data) ? msgsB.body.data : (msgsB.body.data && msgsB.body.data.items) || [];
  assert.equal(itens.length, 0, 'nenhuma mensagem pode ter sido gravada para a pessoa de A');
});
