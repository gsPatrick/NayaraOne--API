'use strict';

// M5-A0323 (Guia §6 assertPermission(ctx, 'contracts.version.approve'); DEC-073 "Livro"): a aprovação da versão exige a
// permissão com o nome do livro, sem mapa para legal:approve. HTTP real com os usuários do seed de dois tenants; os tokens
// com permissões recortadas são assinados com a mesma chave do app (o middleware lê as permissões do token).
process.env.PORT = process.env.M5FECH_CT_PORT || '5534';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./m5fech.contratos.helpers');
const { signAccessToken } = require('../src/utils/jwt');
const { sequelize } = require('../src/models');

let pular = null;
before(async () => { pular = await h.pronto(); });
after(h.encerrar);

function tokenCom(permissions) {
  const t = h.tenantOf('A:gestor');
  return signAccessToken({ sub: t.userId, group_id: t.groupId, company_id: t.companyId, roles: ['m5ct-recorte'], permissions });
}

async function chamar(token, method, path, body) {
  const res = await fetch(`http://127.0.0.1:${process.env.PORT}/api/v1${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body || {}) });
  const json = await res.json().catch(() => null);
  return { status: res.status, code: json && json.error ? json.error.code : null, required: json && json.error && json.error.details ? json.error.details.required : null };
}

const statusDaVersao = async (id) => (await h.sql('A:gestor', 'SELECT status FROM legal.contract_versions WHERE id = :id', { id }))[0].status;
const SEM_LIVRO = ['legal:read', 'legal:create', 'legal:update', 'legal:approve', 'legal:sign'];

test('M5-A0323: sem contracts.version.approve a aprovação da versão é 403 — legal:approve sozinho não basta (rota do Guia §14 e /transition para APPROVED)', async (t) => {
  if (pular) return t.skip(pular);
  const c = await h.contratoEmRevisao('A:gestor');
  const token = tokenCom(SEM_LIVRO);
  const aprova = await chamar(token, 'POST', `/contract-versions/${c.versionId}/approve`);
  assert.equal(aprova.status, 403);
  assert.equal(aprova.code, 'PERMISSION_DENIED');
  assert.equal(aprova.required, 'contracts.version.approve');
  const transicao = await chamar(token, 'POST', `/legal/contracts/${c.contractId}/transition`, { targetStatus: 'APPROVED' });
  assert.equal(transicao.status, 403);
  assert.equal(transicao.required, 'contracts.version.approve');
  const maker = await h.http('A:maker', 'POST', `/contract-versions/${c.versionId}/approve`, {});
  assert.equal(maker.status, 403);
  assert.equal(await statusDaVersao(c.versionId), 'DRAFT', 'nada foi aprovado');
  // Outros destinos da transição genérica não pedem a permissão de aprovação de versão.
  const volta = await chamar(token, 'POST', `/legal/contracts/${c.contractId}/transition`, { targetStatus: 'DRAFT' });
  assert.equal(volta.status, 200);
});

test('M5-A0323: com contracts.version.approve a versão é aprovada (perfil do seed e token só com a permissão do livro)', async (t) => {
  if (pular) return t.skip(pular);
  const c1 = await h.contratoEmRevisao('A:gestor');
  const checker = await h.http('A:checker', 'POST', `/contract-versions/${c1.versionId}/approve`, {});
  assert.equal(checker.status, 200, JSON.stringify(checker.body));
  assert.equal(await statusDaVersao(c1.versionId), 'APPROVED');

  const c2 = await h.contratoEmRevisao('A:gestor');
  const soLivro = await chamar(tokenCom(['legal:read', 'contracts.version.approve']), 'POST', `/contract-versions/${c2.versionId}/approve`);
  assert.equal(soLivro.status, 200, 'a rota do Guia §6 exige a permissão do livro, não legal:approve');
  assert.equal(await statusDaVersao(c2.versionId), 'APPROVED');
});

test('M5-A0323: a permissão existe no catálogo e todo papel com legal:approve também tem contracts.version.approve', async (t) => {
  if (pular) return t.skip(pular);
  const [cat] = await sequelize.query("SELECT code, risk_level FROM core.permissions WHERE code = 'contracts.version.approve'");
  assert.equal(cat.length, 1);
  assert.equal(cat[0].risk_level, 'HIGH');
  const faltando = await h.sql('A:gestor', `SELECT r.name FROM core.roles r
      JOIN core.role_permissions rp ON rp.role_id = r.id JOIN core.permissions p ON p.id = rp.permission_id AND p.code = 'legal:approve'
     WHERE NOT EXISTS (SELECT 1 FROM core.role_permissions x JOIN core.permissions q ON q.id = x.permission_id AND q.code = 'contracts.version.approve' WHERE x.role_id = r.id)`);
  assert.deepEqual(faltando, []);
});
