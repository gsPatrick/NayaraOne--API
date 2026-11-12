'use strict';

// Campos do corpo das rotas de mensagem entre duas empresas do MESMO grupo, pelo caminho HTTP real (login com senha, JWT, auth, tenant
// middleware e RLS). Achados da verificação independente de 12/11/2026, rodada 4 (`Maturacao/fechamento-m3-m6/verificacao/m9-rodada4.md`):
// 1. `conversationId` ou `mediaQuarantineId` como objeto (`{"id": ...}`) davam 500 (o valor ia direto para o findOne); na base ea9d2289, 400.
// 2. `authorUserId` vinha do corpo: a empresa B gravava mensagem (201) com autor de um usuário que só tem vínculo com a empresa A.
// 3. `externalMessageId` era único no banco inteiro (índice da 675): B, com o id de uma mensagem de A, recebia 409 UNIQUE_CONSTRAINT_VIOLATION
//    (sabia que o id existe em outra empresa) e A ficava impedida de usar o id que B usou.
// 4. `personId` ou `opportunityId` como lista davam 500 (findByPk com a lista), em POST /messages e em POST /messages/send.
// Regras: forma errada em campo de referência é 400 MESSAGE_VALIDATION, antes de consultar (DI-M9R-8); o autor é quem faz o pedido (DI-M9R-9);
// o id externo sem connection é único por empresa (DI-M9R-10, migration 20260101009976).
//
// GRAVA de verdade (empresa, papel, usuários, pessoa, conversa, quarentena e mensagem): só roda em banco descartável (DISPOSABLE_DB=1, dado por
// scripts/withDisposableDb.js) ou no CI, depois do seed de dois tenants. Fora disso o teste é PULADO com o motivo.

process.env.PORT = process.env.CRM_MESSAGES_FIELDS_SAME_GROUP_HTTP_TEST_PORT || require('./marco9/_helpers/portaLivre').portaLivre();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');

const { TENANTS } = require('../scripts/seed-ci-two-tenants');
const { sequelize, Group, Company, User, UserMembership, Role, Permission, RolePermission, CrmConversation, FileQuarantine } = require('../src/models');

const PERMISSOES = ['people:read', 'people:create', 'crm:messages:read', 'crm:messages:create', 'crm:messages:update'];
const SUFIXO = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const EMAIL = `ci-msg-campos-mesmo-grupo-${SUFIXO}@ci.nayaraone.test`;

let skipReason = null;
let appLoaded = false;
let baseUrl;
let groupId;
let userId;
let soDeA;
let empresaA;
let empresaB;
const tokens = {};

/** Transação no contexto da empresa (RLS por empresa), como a do tenant middleware. */
async function naEmpresa(companyId, fn) {
  return sequelize.transaction(async (transaction) => {
    await sequelize.query("SELECT set_config('app.group_id', :g, true), set_config('app.company_id', :c, true), set_config('app.user_id', :u, true)", { replacements: { g: groupId, c: companyId, u: userId || '' }, transaction });
    return fn(transaction);
  });
}

/** Vínculo do usuário numa empresa, com papel próprio daquela empresa (papéis são por empresa). */
async function vincular(user, companyId, permissoes) {
  await naEmpresa(companyId, async (transaction) => {
    const role = await Role.create({ groupId, companyId, name: `CI MSG CAMPOS ${user.email}`, description: 'Perfil fictício do teste dos campos da mensagem.', isSystem: false }, { transaction });
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

const novoUsuario = async (email) => User.create({ name: `CI ${email}`, email, passwordHash: await bcrypt.hash(process.env.CI_TENANT_USERS_PASSWORD, 10), status: 'ACTIVE' });

before(async () => {
  if (process.env.DISPOSABLE_DB !== '1' && !process.env.CI) { skipReason = 'Grava dados: só roda em banco descartável (scripts/withDisposableDb.js) ou no CI.'; return; }
  if (!process.env.CI_TENANT_USERS_PASSWORD) { skipReason = 'CI_TENANT_USERS_PASSWORD ausente (senha dos usuários fictícios do CI).'; return; }
  const group = await Group.findOne({ where: { name: TENANTS[0].groupName } });
  if (!group) { skipReason = 'Grupo do seed de dois tenants ausente: rode scripts/seed-ci-two-tenants.js.'; return; }
  groupId = group.id;
  const permissoes = await Permission.findAll({ where: { code: PERMISSOES } });
  assert.equal(permissoes.length, PERMISSOES.length, `permissões ausentes do catálogo: ${PERMISSOES.filter((c) => !permissoes.some((p) => p.code === c))}`);

  await sequelize.transaction(async (transaction) => {
    await sequelize.query("SELECT set_config('app.group_id', :g, true)", { replacements: { g: groupId }, transaction });
    empresaA = await Company.findOne({ where: { groupId, name: TENANTS[0].companyName }, transaction });
    empresaB = await Company.create({ groupId, name: `CI — Empresa dos campos da mensagem do mesmo grupo ${SUFIXO}`, status: 'ACTIVE' }, { transaction });
  });
  assert.ok(empresaA, 'empresa A do seed CI não encontrada');
  const user = await novoUsuario(EMAIL);
  userId = user.id;
  await vincular(user, empresaA.id, permissoes);
  await vincular(user, empresaB.id, permissoes);
  // usuário que só tem vínculo com a empresa A (o autor que B tentava gravar)
  soDeA = await novoUsuario(`ci-msg-campos-so-a-${SUFIXO}@ci.nayaraone.test`);
  await vincular(soDeA, empresaA.id, permissoes);

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

const esperar400 = (r, rotulo, campo) => {
  assert.equal(r.status, 400, `${rotulo} deveria dar 400: ${r.status} ${JSON.stringify(r.body)}`);
  assert.equal(r.body.error.code, 'MESSAGE_VALIDATION', `${rotulo}: código inesperado ${r.body.error.code}`);
  if (campo) assert.match(r.body.error.message, new RegExp(`"${campo}"`), `${rotulo}: a mensagem cita o campo`);
};

/** Pessoa e conversa de WhatsApp dela na empresa. */
async function conversaDa(quem, empresa) {
  const p = await call(quem, 'POST', '/people', { personType: 'PF', legalName: `Pessoa ${quem} campos ${SUFIXO}` });
  assert.equal(p.status, 201, JSON.stringify(p.body));
  const conversa = await naEmpresa(empresa.id, (transaction) => CrmConversation.create({ groupId, companyId: empresa.id, personId: p.body.data.id, channel: 'WHATSAPP' }, { transaction }));
  return { personId: p.body.data.id, conversationId: conversa.id };
}

const midiaDa = (empresa) => naEmpresa(empresa.id, async (transaction) => (await FileQuarantine.create({
  groupId, companyId: empresa.id, originKey: `ci-msg-campos/${SUFIXO}/${crypto.randomUUID()}`, fileName: 'foto.png', declaredMime: 'image/png', sizeBytes: 2048,
  sha256: crypto.randomBytes(32).toString('hex'), expiresAt: new Date(Date.now() + 86400000),
}, { transaction })).id);

/** Mensagens que a empresa vê (RLS da empresa) com o filtro dado. */
const contar = (empresa, where, replacements) => naEmpresa(empresa.id, async (transaction) => {
  const [[{ n }]] = await sequelize.query(`SELECT count(*)::int AS n FROM crm.messages WHERE ${where}`, { replacements, transaction });
  return n;
});
const doTeste = (empresa) => contar(empresa, 'body LIKE :b', { b: `%campos ${SUFIXO}%` });

const corpo = (extra) => ({ channel: 'WHATSAPP', direction: 'INBOUND', authorType: 'CLIENT', body: `Mensagem do teste de campos ${SUFIXO}`, ...extra });

test('rodada 4, item 1: conversationId ou mediaQuarantineId como objeto dá 400 MESSAGE_VALIDATION (não 500) e não grava', async (t) => {
  if (skipReason) return t.skip(skipReason);
  const deA = await conversaDa('A', empresaA);
  const deB = await conversaDa('B', empresaB);
  const midiaA = await midiaDa(empresaA);
  const antes = await doTeste(empresaB);
  esperar400(await call('B', 'POST', '/messages', corpo({ conversationId: { id: deA.conversationId } })), 'conversationId {id: A}', 'conversationId');
  esperar400(await call('B', 'POST', '/messages', corpo({ conversationId: { id: deB.conversationId } })), 'conversationId {id: B}', 'conversationId');
  esperar400(await call('B', 'POST', '/messages', corpo({ mediaQuarantineId: { id: midiaA } })), 'mediaQuarantineId {id: A}', 'mediaQuarantineId');
  esperar400(await call('B', 'POST', '/messages', corpo({ conversationId: [deB.conversationId, deA.conversationId] })), 'conversationId [B, A]', 'conversationId');
  esperar400(await call('B', 'POST', '/messages', corpo({ mediaQuarantineId: 123 })), 'mediaQuarantineId número', 'mediaQuarantineId');
  esperar400(await call('B', 'POST', '/messages/send', { kind: 'template', templateName: 'boas_vindas', to: '+5511999990000', conversationId: { id: deA.conversationId } }), 'send conversationId {id: A}', 'conversationId');
  assert.equal(await doTeste(empresaB), antes, 'nenhuma mensagem gravada em B');
  // controle: o UUID em texto continua valendo (o da própria empresa grava; o de A continua 404)
  const ok = await call('B', 'POST', '/messages', corpo({ personId: deB.personId, conversationId: deB.conversationId }));
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  const fora = await call('B', 'POST', '/messages', corpo({ conversationId: deA.conversationId }));
  assert.equal(fora.status, 404, JSON.stringify(fora.body));
  assert.equal(fora.body.error.code, 'CONVERSATION_NOT_FOUND');
});

test('rodada 4, item 2: authorUserId do corpo é ignorado; o autor é quem faz o pedido, nunca um usuário só da empresa A', async (t) => {
  if (skipReason) return t.skip(skipReason);
  const r = await call('B', 'POST', '/messages', corpo({ direction: 'OUTBOUND', authorType: 'EMPLOYEE', authorUserId: soDeA.id }));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.data.authorUserId, userId, 'o autor é o usuário da sessão');
  const gravada = await naEmpresa(empresaB.id, async (transaction) => (await sequelize.query('SELECT company_id, author_user_id FROM crm.messages WHERE id = :id', { replacements: { id: r.body.data.id }, transaction }))[0][0]);
  assert.deepEqual([gravada.company_id, gravada.author_user_id], [empresaB.id, userId]);
  assert.equal(await contar(empresaB, 'author_user_id = :u', { u: soDeA.id }), 0, 'nenhuma mensagem de B com autor de um usuário só de A');
  // o mesmo vale com o corpo trazendo autor inválido (objeto): ignorado, não é 500
  const r2 = await call('A', 'POST', '/messages', corpo({ authorUserId: { id: soDeA.id } }));
  assert.equal(r2.status, 201, JSON.stringify(r2.body));
  assert.equal(r2.body.data.authorUserId, userId);
});

test('rodada 4, item 3: externalMessageId é único por empresa — B usa o id de A (201, outra mensagem) e A usa o de B; a repetição só deduplica na própria empresa', async (t) => {
  if (skipReason) return t.skip(skipReason);
  const idDeA = `wamid.campos-a-${SUFIXO}`;
  const deA = await call('A', 'POST', '/messages', corpo({ externalMessageId: idDeA }));
  assert.equal(deA.status, 201, JSON.stringify(deA.body));
  const deB = await call('B', 'POST', '/messages', corpo({ externalMessageId: idDeA }));
  assert.equal(deB.status, 201, `B com o id externo de uma mensagem de A não pode receber 409: ${deB.status} ${JSON.stringify(deB.body)}`);
  assert.notEqual(deB.body.data.id, deA.body.data.id, 'B ganha a própria mensagem, não a de A');
  assert.equal(deB.body.data.companyId, empresaB.id);
  // a repetição na própria empresa devolve a mensagem que já existe (deduplicação), sem 409
  const deNovoA = await call('A', 'POST', '/messages', corpo({ externalMessageId: idDeA, body: 'outro corpo' }));
  assert.equal(deNovoA.status, 201, JSON.stringify(deNovoA.body));
  assert.equal(deNovoA.body.data.id, deA.body.data.id);
  const deNovoB = await call('B', 'POST', '/messages', corpo({ externalMessageId: idDeA }));
  assert.equal(deNovoB.body.data.id, deB.body.data.id);
  // sentido contrário: o id que B usou primeiro continua livre para A
  const idDeB = `wamid.campos-b-${SUFIXO}`;
  assert.equal((await call('B', 'POST', '/messages', corpo({ externalMessageId: idDeB }))).status, 201);
  const aDepois = await call('A', 'POST', '/messages', corpo({ externalMessageId: idDeB }));
  assert.equal(aDepois.status, 201, `A não pode ficar impedida de usar o id que B usou: ${aDepois.status} ${JSON.stringify(aDepois.body)}`);
  assert.equal(aDepois.body.data.companyId, empresaA.id);
  for (const e of [empresaA, empresaB]) for (const id of [idDeA, idDeB]) assert.equal(await contar(e, 'external_message_id = :x', { x: id }), 1, `uma mensagem por empresa com ${id}`);
  // forma: lista, objeto, número ou texto acima de 128 caracteres é 400
  for (const v of [[idDeA], { id: idDeA }, 123, 'x'.repeat(129)]) esperar400(await call('B', 'POST', '/messages', corpo({ externalMessageId: v })), `externalMessageId ${JSON.stringify(v).slice(0, 20)}`, 'externalMessageId');
});

test('rodada 4, item 4: personId ou opportunityId como lista (ou objeto, número) dá 400 MESSAGE_VALIDATION em POST /messages, POST /messages/send e GET /messages', async (t) => {
  if (skipReason) return t.skip(skipReason);
  const deA = await conversaDa('A', empresaA);
  const deB = await conversaDa('B', empresaB);
  const antes = await doTeste(empresaB);
  const casos = [
    ['personId', [deB.personId, deA.personId]], ['personId', [deB.personId]], ['personId', { id: deB.personId }], ['personId', 7],
    ['opportunityId', [crypto.randomUUID()]], ['opportunityId', { id: crypto.randomUUID() }], ['opportunityId', true],
  ];
  for (const [campo, v] of casos) {
    esperar400(await call('B', 'POST', '/messages', corpo({ [campo]: v })), `POST /messages ${campo}=${JSON.stringify(v)}`, campo);
    esperar400(await call('B', 'POST', '/messages/send', { kind: 'template', templateName: 'boas_vindas', to: '+5511999990000', [campo]: v }), `POST /messages/send ${campo}=${JSON.stringify(v)}`, campo);
  }
  // outros campos do corpo de POST /messages que iam ao banco sem conferir a forma
  esperar400(await call('B', 'POST', '/messages', corpo({ actionKey: { k: 1 } })), 'actionKey objeto', 'actionKey');
  esperar400(await call('B', 'POST', '/messages', corpo({ body: { texto: 'x' } })), 'body objeto', 'body');
  esperar400(await call('B', 'POST', '/messages', corpo({ personId: 'nao-e-uuid' })), 'personId texto que não é UUID', 'personId');
  assert.equal(await doTeste(empresaB), antes, 'nenhuma mensagem gravada em B');
  // a mesma forma na consulta da lista
  esperar400(await call('B', 'GET', `/messages?personId=${deB.personId}&personId=${deA.personId}`), 'GET /messages?personId=B&personId=A', 'personId');
  esperar400(await call('B', 'GET', `/messages?opportunityId[id]=${crypto.randomUUID()}`), 'GET /messages?opportunityId[id]=...', 'opportunityId');
  // controle: os UUIDs em texto continuam valendo (B grava com a própria pessoa; a pessoa de A continua 404)
  const ok = await call('B', 'POST', '/messages', corpo({ personId: deB.personId }));
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  const lista = await call('B', 'GET', `/messages?personId=${deB.personId}`);
  assert.equal(lista.status, 200, JSON.stringify(lista.body));
  assert.ok(lista.body.data.some((m) => m.id === ok.body.data.id));
  const fora = await call('B', 'POST', '/messages', corpo({ personId: deA.personId }));
  assert.equal(fora.status, 404, JSON.stringify(fora.body));
  assert.equal(fora.body.error.code, 'PERSON_NOT_FOUND');
});
