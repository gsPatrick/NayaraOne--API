'use strict';

// Isolamento da CONVERSA e da MÍDIA EM QUARENTENA citadas pela mensagem, entre duas empresas do MESMO grupo, pelo caminho HTTP real
// (login com senha, JWT, auth, tenant middleware e RLS). Achado ISO-R2 da verificação independente de 12/11/2026 (rodada 3):
// a empresa B chamando POST /messages com o conversationId da conversa da empresa A recebia 201 e a mensagem de B ficava gravada
// apontando para a conversa de A (a FK simples conversation_id -> crm.conversations(id) não passa pelo RLS); com um conversationId
// inexistente, 500 INTERNAL_ERROR (messages_conversation_id_fkey). O mediaQuarantineId não tinha conferência nenhuma.
// Regra (DI-M9R-6): conversa ou mídia fora da empresa de quem chama (de outra empresa ou inexistente) dá 404 antes de gravar:
// CONVERSATION_NOT_FOUND e INTEGRATION_MESSAGING_MEDIA_NOT_FOUND. Vale para POST /messages e para POST /messages/send (inclusive com
// a conexão de mensageria ativa em B, quando o envio chegaria a gravar). A própria empresa continua usando a sua conversa e a sua mídia.
//
// GRAVA de verdade (empresa, papel, usuário, pessoa, conversa, quarentena, conexão e mensagem): só roda em banco descartável
// (DISPOSABLE_DB=1, dado por scripts/withDisposableDb.js) ou no CI, depois do seed de dois tenants. Fora disso o teste é PULADO com o motivo.

process.env.PORT = process.env.CRM_MESSAGES_REFS_SAME_GROUP_HTTP_TEST_PORT || require('./marco9/_helpers/portaLivre').portaLivre();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');

const { TENANTS } = require('../scripts/seed-ci-two-tenants');
const { sequelize, Group, Company, User, UserMembership, Role, Permission, RolePermission, CrmConversation, FileQuarantine } = require('../src/models');
const registry = require('../src/features/integrations/registry/registry.service');
const { transitionConnection } = require('../src/features/integrations/registry/connections.transition');
const { getSecretStore, webhookRefOf } = require('../src/features/integrations/secrets');
const { useTempSecretStore } = require('./marco9/_helpers/mktSecretStore');

const PERMISSOES = ['people:read', 'people:create', 'crm:messages:read', 'crm:messages:create', 'crm:messages:update'];
const SUFIXO = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const EMAIL = `ci-msg-refs-mesmo-grupo-${SUFIXO}@ci.nayaraone.test`;
const MODELO = { name: 'boas_vindas', language: 'pt_BR', category: 'UTILITY', variables: 0, approved: true, approvedAt: '2026-01-01T00:00:00Z' };

let skipReason = null;
let appLoaded = false;
let desligarCofre = null;
let baseUrl;
let groupId;
let userId;
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
    const role = await Role.create({ groupId, companyId, name: `CI MSG REFS MESMO GRUPO ${SUFIXO}`, description: 'Perfil fictício do teste de isolamento de conversa e mídia.', isSystem: false }, { transaction });
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
  groupId = group.id;
  const permissoes = await Permission.findAll({ where: { code: PERMISSOES } });
  assert.equal(permissoes.length, PERMISSOES.length, `permissões ausentes do catálogo: ${PERMISSOES.filter((c) => !permissoes.some((p) => p.code === c))}`);

  await sequelize.transaction(async (transaction) => {
    await sequelize.query("SELECT set_config('app.group_id', :g, true)", { replacements: { g: groupId }, transaction });
    empresaA = await Company.findOne({ where: { groupId, name: TENANTS[0].companyName }, transaction });
    empresaB = await Company.create({ groupId, name: `CI — Empresa de conversa e mídia do mesmo grupo ${SUFIXO}`, status: 'ACTIVE' }, { transaction });
  });
  assert.ok(empresaA, 'empresa A do seed CI não encontrada');
  const user = await User.create({ name: `CI msg refs mesmo grupo ${SUFIXO}`, email: EMAIL, passwordHash: await bcrypt.hash(process.env.CI_TENANT_USERS_PASSWORD, 10), status: 'ACTIVE' });
  userId = user.id;
  await vincular(user, empresaA.id, permissoes);
  await vincular(user, empresaB.id, permissoes);
  desligarCofre = useTempSecretStore();

  require('../app');
  appLoaded = true;
  baseUrl = `http://127.0.0.1:${process.env.PORT}/api/v1`;
  await new Promise((resolve) => setTimeout(resolve, 300));
  tokens.A = await entrar(empresaA.id);
  tokens.B = await entrar(empresaB.id);
});

after(async () => {
  if (empresaB) {
    // a conexão de mensageria de B sai de cena (B é desta execução; nada da empresa A muda)
    await naEmpresa(empresaB.id, (t) => sequelize.query("UPDATE integration.connections SET status = 'DISABLED' WHERE company_id = :c AND provider_code LIKE 'messaging-%'", { replacements: { c: empresaB.id }, transaction: t })).catch(() => {});
  }
  if (desligarCofre) desligarCofre();
  await sequelize.close().catch(() => {});
  if (appLoaded) process.exit(0);
});

async function call(quem, method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens[quem]}` }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const esperar404 = (r, rotulo, code) => {
  assert.equal(r.status, 404, `${rotulo} deveria dar 404: ${r.status} ${JSON.stringify(r.body)}`);
  assert.equal(r.body.error.code, code, `${rotulo}: código inesperado ${r.body.error.code}`);
};

/** Pessoa e conversa de WhatsApp dela na empresa (a conversa nasce como no fluxo de mensageria: crm.conversations da empresa). */
async function conversaDa(quem, empresa) {
  const p = await call(quem, 'POST', '/people', { personType: 'PF', legalName: `Pessoa ${quem} conversa ${SUFIXO}` });
  assert.equal(p.status, 201, JSON.stringify(p.body));
  const conversa = await naEmpresa(empresa.id, (transaction) => CrmConversation.create({ groupId, companyId: empresa.id, personId: p.body.data.id, channel: 'WHATSAPP' }, { transaction }));
  return { personId: p.body.data.id, conversationId: conversa.id };
}

/** Linha da quarentena da empresa (mídia recebida em verificação), como a que o recebimento grava. */
const midiaDa = (empresa) => naEmpresa(empresa.id, async (transaction) => (await FileQuarantine.create({
  groupId, companyId: empresa.id, originKey: `ci-iso-r2/${SUFIXO}/${crypto.randomUUID()}`, fileName: 'foto.png', declaredMime: 'image/png', sizeBytes: 2048,
  sha256: crypto.randomBytes(32).toString('hex'), expiresAt: new Date(Date.now() + 86400000),
}, { transaction })).id);

/** Mensagens da empresa B que citam a conversa ou a mídia (consulta no contexto de B: o RLS mostra só as linhas de B). */
const gravadasPorB = (coluna, id) => naEmpresa(empresaB.id, async (transaction) => {
  const [[{ n }]] = await sequelize.query(`SELECT count(*)::int AS n FROM crm.messages WHERE ${coluna} = :id`, { replacements: { id }, transaction });
  return n;
});

const corpo = (extra) => ({ channel: 'WHATSAPP', direction: 'INBOUND', authorType: 'CLIENT', body: `Mensagem do teste ISO-R2 ${SUFIXO}`, ...extra });

test('HTTP mesmo grupo: POST /messages da empresa B com a conversa de A, ou com conversa inexistente, dá 404 CONVERSATION_NOT_FOUND e não grava', async (t) => {
  if (skipReason) return t.skip(skipReason);
  const { conversationId } = await conversaDa('A', empresaA);
  esperar404(await call('B', 'POST', '/messages', corpo({ conversationId })), 'POST /messages com a conversa de A pela empresa B', 'CONVERSATION_NOT_FOUND');
  esperar404(await call('B', 'POST', '/messages', corpo({ conversationId: crypto.randomUUID() })), 'POST /messages com conversa inexistente pela empresa B', 'CONVERSATION_NOT_FOUND');
  esperar404(await call('A', 'POST', '/messages', corpo({ conversationId: crypto.randomUUID() })), 'POST /messages com conversa inexistente pela empresa A', 'CONVERSATION_NOT_FOUND');
  assert.equal(await gravadasPorB('conversation_id', conversationId), 0, 'nenhuma mensagem de B pode apontar para a conversa de A');

  // controle: a empresa A grava na própria conversa, e a B na dela
  const daA = await call('A', 'POST', '/messages', corpo({ conversationId }));
  assert.equal(daA.status, 201, JSON.stringify(daA.body));
  assert.equal(daA.body.data.conversationId, conversationId);
  const deB = await conversaDa('B', empresaB);
  const naB = await call('B', 'POST', '/messages', corpo({ personId: deB.personId, conversationId: deB.conversationId }));
  assert.equal(naB.status, 201, JSON.stringify(naB.body));
  assert.equal(naB.body.data.conversationId, deB.conversationId);
});

test('HTTP mesmo grupo: POST /messages da empresa B com a mídia em quarentena de A, ou inexistente, dá 404 INTEGRATION_MESSAGING_MEDIA_NOT_FOUND e não grava', async (t) => {
  if (skipReason) return t.skip(skipReason);
  const midiaA = await midiaDa(empresaA);
  esperar404(await call('B', 'POST', '/messages', corpo({ mediaQuarantineId: midiaA })), 'POST /messages com a mídia de A pela empresa B', 'INTEGRATION_MESSAGING_MEDIA_NOT_FOUND');
  esperar404(await call('B', 'POST', '/messages', corpo({ mediaQuarantineId: crypto.randomUUID() })), 'POST /messages com mídia inexistente pela empresa B', 'INTEGRATION_MESSAGING_MEDIA_NOT_FOUND');
  assert.equal(await gravadasPorB('media_quarantine_id', midiaA), 0, 'nenhuma mensagem de B pode apontar para a mídia de A');

  // controle: cada empresa cita a própria mídia
  const daA = await call('A', 'POST', '/messages', corpo({ mediaQuarantineId: midiaA }));
  assert.equal(daA.status, 201, JSON.stringify(daA.body));
  assert.equal(daA.body.data.mediaQuarantineId, midiaA);
  const midiaB = await midiaDa(empresaB);
  const daB = await call('B', 'POST', '/messages', corpo({ mediaQuarantineId: midiaB }));
  assert.equal(daB.status, 201, JSON.stringify(daB.body));
  assert.equal(daB.body.data.mediaQuarantineId, midiaB);
});

test('HTTP mesmo grupo: POST /messages/send da empresa B (com conexão de mensageria ativa) com a conversa de A, ou inexistente, dá 404 CONVERSATION_NOT_FOUND e não enfileira', async (t) => {
  if (skipReason) return t.skip(skipReason);
  // B com conexão de mensageria ATIVA: sem a conferência, o envio sem pessoa usaria o conversationId do corpo e gravaria (202).
  const secretRef = `company/${empresaB.id}/webhook/${SUFIXO}`.toLowerCase();
  const ctxB = { groupId, companyId: empresaB.id, userId };
  const conn = await naEmpresa(empresaB.id, (transaction) => registry.createConnection({ providerCode: 'messaging-sandbox', environment: 'SANDBOX', label: `CI ISO-R2 ${SUFIXO}`, secretRef }, ctxB, transaction));
  await getSecretStore().put(webhookRefOf(secretRef), `wh-${crypto.randomBytes(12).toString('hex')}`, {});
  await naEmpresa(empresaB.id, (transaction) => sequelize.query('UPDATE integration.connections SET config_json = CAST(:cfg AS jsonb) WHERE id = :id', { replacements: { id: conn.id, cfg: JSON.stringify({ templates: [MODELO] }) }, transaction }));
  await naEmpresa(empresaB.id, (transaction) => transitionConnection(conn.id, 'ACTIVE', ctxB, transaction));

  const { conversationId } = await conversaDa('A', empresaA);
  const envio = (id) => ({ kind: 'template', templateName: MODELO.name, conversationId: id, to: '+5511999990000' });
  esperar404(await call('B', 'POST', '/messages/send', envio(conversationId)), 'POST /messages/send com a conversa de A pela empresa B', 'CONVERSATION_NOT_FOUND');
  esperar404(await call('B', 'POST', '/messages/send', envio(crypto.randomUUID())), 'POST /messages/send com conversa inexistente pela empresa B', 'CONVERSATION_NOT_FOUND');
  assert.equal(await gravadasPorB('conversation_id', conversationId), 0, 'nenhuma mensagem de B pode apontar para a conversa de A');
  const [[{ n }]] = await naEmpresa(empresaB.id, (transaction) => sequelize.query('SELECT count(*)::int AS n FROM integration.dispatches WHERE connection_id = :c', { replacements: { c: conn.id }, transaction }));
  assert.equal(n, 0, 'nenhum envio pode ter sido enfileirado');

  // controle: a mesma conexão de B envia sem conversa (o 404 acima não é falta de conexão nem de modelo)
  const ok = await call('B', 'POST', '/messages/send', { kind: 'template', templateName: MODELO.name, to: '+5511999990000' });
  assert.equal(ok.status, 202, JSON.stringify(ok.body));
});
