'use strict';

// Vínculo de pessoa entre DUAS empresas do MESMO grupo pelo caminho HTTP real (login com senha, JWT, auth, tenant middleware e
// RLS; ISO-4 da verificação de 11/11/2026; DI-M9I-2 a DI-M9I-6). O mesmo usuário entra na empresa A e na B; um segundo usuário
// só entra na B e não tem people:link. GRAVA de verdade: só roda em banco descartável (DISPOSABLE_DB=1) ou no CI.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');

const { sequelize, Group, Company, User, UserMembership, Role, Permission, RolePermission } = require('../src/models');
const { randomCpf } = require('./helpers/pessoasVinculo');

process.env.PORT = process.env.PEOPLE_LINK_HTTP_TEST_PORT || '21683';

const BASE = ['people:read', 'people:create', 'people:update', 'people:delete'];
const SUFIXO = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const EMAIL = `ci-vinculo-${SUFIXO}@ci.nayaraone.test`;
const EMAIL_SEM_LINK = `ci-vinculo-sem-${SUFIXO}@ci.nayaraone.test`;
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n').toString('base64');

let skipReason = null; let appLoaded = false; let baseUrl; let grupo; let empresaA; let empresaB; let usuario;
const tokens = {};

async function papel(user, companyId, codigos) {
  const permissoes = await Permission.findAll({ where: { code: codigos } });
  assert.equal(permissoes.length, codigos.length, `permissões ausentes: ${codigos.filter((c) => !permissoes.some((p) => p.code === c))}`);
  await sequelize.transaction(async (transaction) => {
    await sequelize.query("SELECT set_config('app.group_id', :g, true), set_config('app.company_id', :c, true)", { replacements: { g: grupo.id, c: companyId }, transaction });
    const role = await Role.create({ groupId: grupo.id, companyId, name: `CI VINCULO ${SUFIXO} ${codigos.length}`, description: 'Perfil fictício do teste de vínculo.', isSystem: false }, { transaction });
    for (const p of permissoes) await RolePermission.create({ roleId: role.id, permissionId: p.id }, { transaction });
    await UserMembership.create({ userId: user.id, groupId: grupo.id, companyId, roleId: role.id, status: 'ACTIVE' }, { transaction });
  });
}

async function entrar(email, companyId) {
  let res; let body;
  for (let i = 0; i < 5; i += 1) {
    res = await fetch(`${baseUrl}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: process.env.CI_TENANT_USERS_PASSWORD, companyId }) });
    body = await res.json();
    if (res.status !== 409) break;
    await new Promise((r) => setTimeout(r, 200 * (i + 1)));
  }
  assert.equal(res.status, 200, `login ${email}: ${JSON.stringify(body)}`);
  return body.data.accessToken;
}

before(async () => {
  if (process.env.DISPOSABLE_DB !== '1' && !process.env.CI) { skipReason = 'Grava dados: só roda em banco descartável (scripts/withDisposableDb.js) ou no CI.'; return; }
  if (!process.env.CI_TENANT_USERS_PASSWORD) { skipReason = 'CI_TENANT_USERS_PASSWORD ausente.'; return; }
  // Grupo próprio com as duas empresas: não acrescenta empresa ao grupo do seed (testes de outras demandas contam as empresas dele).
  grupo = await Group.create({ name: `CI — Grupo vínculo ${SUFIXO}`, legalName: 'Grupo fictício do teste de vínculo', status: 'ACTIVE' });
  await sequelize.transaction(async (transaction) => {
    await sequelize.query("SELECT set_config('app.group_id', :g, true)", { replacements: { g: grupo.id }, transaction });
    empresaA = await Company.create({ groupId: grupo.id, name: `CI — Vínculo A ${SUFIXO}`, status: 'ACTIVE' }, { transaction });
    empresaB = await Company.create({ groupId: grupo.id, name: `CI — Vínculo B ${SUFIXO}`, status: 'ACTIVE' }, { transaction });
  });
  const hash = await bcrypt.hash(process.env.CI_TENANT_USERS_PASSWORD, 10);
  usuario = await User.create({ name: `CI vínculo ${SUFIXO}`, email: EMAIL, passwordHash: hash, status: 'ACTIVE' });
  const semLink = await User.create({ name: `CI vínculo sem ${SUFIXO}`, email: EMAIL_SEM_LINK, passwordHash: hash, status: 'ACTIVE' });
  await papel(usuario, empresaA.id, BASE);
  await papel(usuario, empresaB.id, [...BASE, 'people:link']);
  await papel(semLink, empresaB.id, BASE);
  require('../app');
  appLoaded = true;
  baseUrl = `http://127.0.0.1:${process.env.PORT}/api/v1`;
  await new Promise((r) => setTimeout(r, 300));
  tokens.A = await entrar(EMAIL, empresaA.id);
  tokens.B = await entrar(EMAIL, empresaB.id);
  tokens.semLink = await entrar(EMAIL_SEM_LINK, empresaB.id);
});

after(async () => {
  await sequelize.close().catch(() => {});
  if (appLoaded) process.exit(0);
});

async function call(quem, method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens[quem]}` }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch (_) { /* corpo não JSON */ }
  return { status: res.status, body: json, text };
}

/** Pessoa de A com contato, endereço, papel, consentimento e documento com arquivo (antivírus real), tudo pela API. */
async function pessoaCompletaDeA(nome, cpf) {
  const p = await call('A', 'POST', '/people', { personType: 'PF', legalName: nome, taxIdNormalized: cpf, riskFlagsJson: { category: 'SO_DE_A' } });
  assert.equal(p.status, 201, p.text);
  const id = p.body.data.id;
  for (const [rota, corpo] of [['contacts', { contactType: 'EMAIL', valueNormalized: `a${SUFIXO}@exemplo.test`, isPrimary: true }], ['addresses', { street: 'Rua de A', number: '1', city: 'São Paulo', state: 'SP' }],
    ['roles', { roleCode: 'CLIENTE' }], ['consents', { channel: 'EMAIL', purpose: 'MARKETING', status: 'OPT_IN' }]]) {
    const r = await call('A', 'POST', `/people/${id}/${rota}`, corpo);
    assert.equal(r.status, 201, `${rota}: ${r.text}`);
  }
  const arq = await call('A', 'POST', '/files', { fileName: `rg-${SUFIXO}.pdf`, mimeType: 'application/pdf', contentBase64: PDF, category: 'people' });
  assert.ok(arq.status < 300, `arquivo: ${arq.text}`);
  const doc = await call('A', 'POST', `/people/${id}/documents`, { documentType: 'RG', fileId: arq.body.data.id });
  assert.equal(doc.status, 201, doc.text);
  return { id, fileId: arq.body.data.id };
}

const semRastro = (r) => JSON.stringify({ ...r.body, error: r.body && r.body.error ? { ...r.body.error, traceId: undefined } : undefined });

test('HTTP vínculo: CPF do grupo em B vira convite ao vínculo (409 sem id nem nome); sem people:link, 403; nome errado e CPF inexistente dão a mesma 422', async (t) => {
  if (skipReason) return t.skip(skipReason);
  const cpf = randomCpf(); const nome = `Joana Vinculo ${SUFIXO} Prado`;
  const { id } = await pessoaCompletaDeA(nome, cpf);
  const criar = await call('B', 'POST', '/people', { personType: 'PF', legalName: 'Outro', taxIdNormalized: cpf });
  assert.equal(criar.status, 409, criar.text);
  assert.equal(criar.body.error.code, 'PERSON_TAX_ID_IN_GROUP');
  assert.equal(criar.body.error.details.podeVincular, true);
  assert.ok(!criar.text.includes(id) && !criar.text.includes(nome), 'a recusa não entrega id nem nome');
  const semPermissao = await call('semLink', 'POST', '/people/links', { taxIdNormalized: cpf, legalName: nome });
  assert.equal(semPermissao.status, 403);
  assert.equal(semPermissao.body.error.code, 'PERMISSION_DENIED');
  const errado = await call('B', 'POST', '/people/links', { taxIdNormalized: cpf, legalName: 'Joana Outra' });
  const inexistente = await call('B', 'POST', '/people/links', { taxIdNormalized: randomCpf(), legalName: nome });
  for (const r of [errado, inexistente]) {
    assert.equal(r.status, 422, r.text);
    assert.equal(r.body.error.code, 'PERSON_LINK_NOT_MATCHED');
    assert.ok(!r.text.includes(id) && !r.text.includes(nome));
  }
  assert.equal(semRastro(errado), semRastro(inexistente), 'as duas recusas são idênticas');
});

test('HTTP vínculo: B vincula e vê só a base; filhos de A (contato, endereço, documento, papel, consentimento, arquivo) continuam invisíveis; A vê tudo o que é dela', async (t) => {
  if (skipReason) return t.skip(skipReason);
  const cpf = randomCpf(); const nome = `Paulo Vinculo ${SUFIXO} Reis`;
  const { id, fileId } = await pessoaCompletaDeA(nome, cpf);
  const v = await call('B', 'POST', '/people/links', { taxIdNormalized: cpf, legalName: `  paulo REIS `, reason: 'Cliente de A em B',
    contacts: [{ contactType: 'PHONE', valueNormalized: '+5511988887777', isPrimary: true }], address: { street: 'Rua de B', city: 'Campinas', state: 'SP' } });
  assert.equal(v.status, 201, v.text);
  assert.equal(v.body.meta.resultado, 'VINCULADA');
  assert.equal(v.body.data.id, id);
  assert.equal(v.body.data.vinculo.origem, 'VINCULADA');
  for (const campo of ['companyId', 'riskFlagsJson', 'createdBy', 'createdAt']) assert.equal(v.body.data[campo], undefined, `não entrega ${campo}`);
  assert.ok(!v.text.includes(empresaA.id) && !v.text.includes('SO_DE_A'), 'nada da empresa A na resposta');

  const sub = async (quem, s) => (await call(quem, 'GET', `/people/${id}/${s}`)).body.data;
  assert.deepEqual((await sub('B', 'contacts')).map((c) => c.valueNormalized), ['+5511988887777']);
  assert.deepEqual((await sub('B', 'addresses')).map((a) => a.street), ['Rua de B']);
  assert.equal((await sub('B', 'documents')).length, 0);
  assert.equal((await sub('B', 'roles')).length, 0);
  assert.equal((await sub('B', 'consents')).length, 0);
  for (const rota of [`/files/${fileId}`, `/files/${fileId}/content`, `/files/${fileId}/download`]) assert.equal((await call('B', 'GET', rota)).status, 404, rota);
  const lista = await call('B', 'GET', '/people');
  const item = lista.body.data.find((p) => p.id === id);
  assert.ok(item && item.vinculo.origem === 'VINCULADA' && item.companyId === undefined, 'na lista de B, a vinculada só com a base');
  assert.ok(lista.body.data.every((p) => p.vinculo.origem === 'VINCULADA' || p.companyId === empresaB.id), 'a lista de B só traz pessoas de B ou vinculadas a B');

  const patch = await call('B', 'PATCH', `/people/${id}`, { preferredName: 'Invasor' });
  assert.equal(patch.status, 403, patch.text);
  assert.equal(patch.body.error.code, 'PERSON_BASE_OWNER_ONLY');
  assert.equal((await call('B', 'DELETE', `/people/${id}`)).body.error.code, 'PERSON_BASE_OWNER_ONLY');
  assert.equal((await call('B', 'POST', `/people/${id}/contacts`, { contactType: 'EMAIL', valueNormalized: `b${SUFIXO}@b.test` })).status, 201);

  const delA = await call('A', 'DELETE', `/people/${id}`);
  assert.equal(delA.status, 409, delA.text);
  assert.equal(delA.body.error.code, 'PERSON_LINKED_ELSEWHERE');
  assert.ok(!delA.text.includes(empresaB.id), 'A não fica sabendo qual empresa tem o vínculo');
  const daA = (await call('A', 'GET', `/people/${id}`)).body.data;
  assert.equal(daA.vinculo.origem, 'PROPRIA');
  assert.deepEqual(daA.riskFlagsJson, { category: 'SO_DE_A' });
  assert.deepEqual(daA.contacts.map((c) => c.companyId), [empresaA.id], 'A não vê os contatos de B');
  for (const s of ['addresses', 'documents', 'roles', 'consents']) assert.equal((await sub('A', s)).length, 1, `A continua com o próprio ${s}`);
  assert.equal((await call('A', 'GET', `/files/${fileId}`)).status, 200, 'A continua lendo o próprio arquivo');
});

test('HTTP vínculo: desfazer exige motivo e people:link, tira a visão de B e é auditado; vincular de novo reativa com os dados de B', async (t) => {
  if (skipReason) return t.skip(skipReason);
  const cpf = randomCpf(); const nome = `Rita Vinculo ${SUFIXO} Lima`;
  const { id } = await pessoaCompletaDeA(nome, cpf);
  assert.equal((await call('B', 'POST', '/people/links', { taxIdNormalized: cpf, legalName: nome, contacts: [{ contactType: 'EMAIL', valueNormalized: `rita${SUFIXO}@b.test` }] })).status, 201);
  const semMotivo = await call('B', 'POST', `/people/${id}/unlink`, {});
  assert.equal(semMotivo.status, 400);
  const dono = await call('A', 'POST', `/people/${id}/unlink`, { reason: 'Encerrar o responsável' });
  assert.equal(dono.status, 403, 'sem people:link na empresa da sessão não se desfaz vínculo');
  const fim = await call('B', 'POST', `/people/${id}/unlink`, { reason: 'Cliente encerrou a relação com B' });
  assert.equal(fim.status, 200, fim.text);
  assert.equal((await call('B', 'GET', `/people/${id}`)).status, 404);
  assert.equal((await call('B', 'POST', `/people/${id}/contacts`, { contactType: 'EMAIL', valueNormalized: 'x@b.test' })).status, 404);
  const [trilha] = await sequelize.transaction(async (transaction) => {
    await sequelize.query("SELECT set_config('app.group_id', :g, true), set_config('app.company_id', :c, true)", { replacements: { g: grupo.id, c: empresaB.id }, transaction });
    return sequelize.query("SELECT action, user_id, reason FROM audit.audit_log WHERE entity_id = :p AND action IN ('people.person.link', 'people.person.unlink') ORDER BY occurred_at", { replacements: { p: id }, transaction });
  });
  assert.deepEqual(trilha.map((x) => x.action), ['people.person.link', 'people.person.unlink']);
  assert.ok(trilha.every((x) => x.user_id === usuario.id));
  assert.equal(trilha[1].reason, 'Cliente encerrou a relação com B');
  const volta = await call('B', 'POST', '/people/links', { taxIdNormalized: cpf, legalName: nome });
  assert.equal(volta.status, 201);
  assert.equal(volta.body.meta.resultado, 'REATIVADA');
  assert.deepEqual(volta.body.data.contacts.map((c) => c.valueNormalized), [`rita${SUFIXO}@b.test`]);
  assert.equal((await call('B', 'POST', '/people/links', { taxIdNormalized: cpf, legalName: nome })).body.meta.resultado, 'JA_NESTA_EMPRESA');
});

test('HTTP vínculo: as recusas ficam na auditoria mesmo com o rollback e, no limite do parâmetro, a próxima tentativa recebe 429', async (t) => {
  if (skipReason) return t.skip(skipReason);
  const contar = () => sequelize.transaction(async (transaction) => {
    await sequelize.query("SELECT set_config('app.group_id', :g, true), set_config('app.company_id', :c, true)", { replacements: { g: grupo.id, c: empresaB.id }, transaction });
    const [[r]] = await sequelize.query("SELECT count(*)::int AS n FROM audit.audit_log WHERE action = 'people.person.link_attempt' AND user_id = :u", { replacements: { u: usuario.id }, transaction });
    return r.n;
  });
  const antes = await contar();
  assert.ok(antes >= 3, `as recusas dos testes anteriores (409 e duas 422) ficaram na trilha: ${antes}`);
  await sequelize.transaction(async (transaction) => {
    await sequelize.query("SELECT set_config('app.group_id', :g, true), set_config('app.company_id', :c, true)", { replacements: { g: grupo.id, c: empresaB.id }, transaction });
    await sequelize.query(`INSERT INTO core.tenant_settings (id, group_id, company_id, key, value, created_at, updated_at)
      VALUES (gen_random_uuid(), :g, :c, 'people.vinculo.tentativas_max', to_jsonb(:n::int), now(), now())`, { replacements: { g: grupo.id, c: empresaB.id, n: antes + 1 }, transaction });
  });
  const ultima = await call('B', 'POST', '/people/links', { taxIdNormalized: randomCpf(), legalName: 'Ninguém' });
  assert.equal(ultima.status, 422);
  assert.equal(await contar(), antes + 1);
  const bloqueada = await call('B', 'POST', '/people/links', { taxIdNormalized: randomCpf(), legalName: 'Ninguém' });
  assert.equal(bloqueada.status, 429, bloqueada.text);
  assert.equal(bloqueada.body.error.code, 'PERSON_LINK_RATE_LIMIT');
  assert.equal(await contar(), antes + 1, 'a tentativa barrada pelo limite não consulta nem conta');
});
