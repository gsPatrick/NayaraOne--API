'use strict';

// Roteiro de reteste da homologação (scripts/homo, cenário "(c) isolamento") rodado contra a API LOCAL, com a "outra empresa" no
// MESMO grupo da empresa A, como na homologação (verificação de 11/11/2026, ISO-7): conta exatamente as conferências esperadas e
// exige zero falhas. Também prova que o arquivo de segredos (senhas e TOTP fora da linha de comando) recusa arquivo dentro de
// repositório e arquivo legível por outros. GRAVA de verdade: só no banco descartável (DISPOSABLE_DB=1) ou no CI.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');

const { sequelize, Group, Company, User, UserMembership, Role, Permission, RolePermission } = require('../src/models');
const { carregarSegredos } = require('../scripts/homo/lib/segredos');

process.env.PORT = process.env.HOMO_ISOLAMENTO_ROTEIRO_TEST_PORT || '21684';

// Como o administrador da homologação, o perfil vê o CPF sem máscara (governance:dlp:view-restricted).
const PERMS = ['people:read', 'people:create', 'people:update', 'people:delete', 'crm:messages:read', 'governance:dlp:view-restricted'];
const SUF = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const EMAIL = `ci-homo-roteiro-${SUF}@ci.nayaraone.test`;
const EMAIL_LEITURA = `ci-homo-roteiro-leitura-${SUF}@ci.nayaraone.test`;
// Sem automação ativa, as 2 conferências de "pausar automação" ficam de fora (na homologação, com a automação, são 32).
const ESPERADAS_SEM_AUTOMACAO = 30;

let skipReason = null; let appLoaded = false; let base; let A; let B;

before(async () => {
  if (process.env.DISPOSABLE_DB !== '1' && !process.env.CI) { skipReason = 'Grava dados: só roda em banco descartável ou no CI.'; return; }
  if (!process.env.CI_TENANT_USERS_PASSWORD) { skipReason = 'CI_TENANT_USERS_PASSWORD ausente.'; return; }
  // Grupo próprio com as duas empresas: não acrescenta empresa ao grupo do seed (testes de outras demandas contam as empresas dele).
  const group = await Group.create({ name: `CI — Grupo roteiro homo ${SUF}`, legalName: 'Grupo fictício do roteiro', status: 'ACTIVE' });
  await sequelize.transaction(async (transaction) => {
    await sequelize.query("SELECT set_config('app.group_id', :g, true)", { replacements: { g: group.id }, transaction });
    A = await Company.create({ groupId: group.id, name: `CI — roteiro homo A ${SUF}`, status: 'ACTIVE' }, { transaction });
    B = await Company.create({ groupId: group.id, name: `CI — roteiro homo B ${SUF}`, status: 'ACTIVE' }, { transaction });
  });
  const permissoes = await Permission.findAll({ where: { code: PERMS } });
  const user = await User.create({ name: `CI roteiro ${SUF}`, email: EMAIL, passwordHash: await bcrypt.hash(process.env.CI_TENANT_USERS_PASSWORD, 10), status: 'ACTIVE' });
  for (const companyId of [A.id, B.id]) {
    await sequelize.transaction(async (transaction) => {
      await sequelize.query("SELECT set_config('app.group_id', :g, true), set_config('app.company_id', :c, true)", { replacements: { g: group.id, c: companyId }, transaction });
      const role = await Role.create({ groupId: group.id, companyId, name: `CI ROTEIRO ${SUF}`, description: 'Perfil fictício do roteiro.', isSystem: false }, { transaction });
      for (const p of permissoes) await RolePermission.create({ roleId: role.id, permissionId: p.id }, { transaction });
      await UserMembership.create({ userId: user.id, groupId: group.id, companyId, roleId: role.id, status: 'ACTIVE' }, { transaction });
    });
  }
  // Perfil somente leitura da empresa A (como o aceite-m9-leitura da homologação): só people:read.
  const leitor = await User.create({ name: `CI roteiro leitura ${SUF}`, email: EMAIL_LEITURA, passwordHash: await bcrypt.hash(process.env.CI_TENANT_USERS_PASSWORD, 10), status: 'ACTIVE' });
  const [ler] = permissoes.filter((p) => p.code === 'people:read');
  await sequelize.transaction(async (transaction) => {
    await sequelize.query("SELECT set_config('app.group_id', :g, true), set_config('app.company_id', :c, true)", { replacements: { g: group.id, c: A.id }, transaction });
    const role = await Role.create({ groupId: group.id, companyId: A.id, name: `CI ROTEIRO LEITURA ${SUF}`, description: 'Perfil fictício somente leitura.', isSystem: false }, { transaction });
    await RolePermission.create({ roleId: role.id, permissionId: ler.id }, { transaction });
    await UserMembership.create({ userId: leitor.id, groupId: group.id, companyId: A.id, roleId: role.id, status: 'ACTIVE' }, { transaction });
  });
  require('../app');
  appLoaded = true;
  base = `http://127.0.0.1:${process.env.PORT}/api/v1`;
  await new Promise((r) => setTimeout(r, 400));
});

after(async () => {
  await sequelize.close().catch(() => {});
  if (appLoaded) process.exit(0);
});

test('roteiro (c) isolamento contra a API local, outra empresa no mesmo grupo: todas as conferências passam, no número esperado', async (t) => {
  if (skipReason) return t.skip(skipReason);
  const { Sessao } = require('../scripts/homo/lib/cliente');
  const { Relato } = require('../scripts/homo/lib/relato');
  const isolamento = require('../scripts/homo/cenarios/isolamento');
  const senha = process.env.CI_TENANT_USERS_PASSWORD;
  const admin = await new Sessao(base, 'admin', EMAIL, senha, { companyId: A.id }).entrar();
  const outra = await new Sessao(base, 'outra empresa', EMAIL, senha, { companyId: B.id }).entrar();
  const leitura = await new Sessao(base, 'somente leitura', EMAIL_LEITURA, senha, { companyId: A.id }).entrar();
  assert.equal(admin.groupId, outra.groupId, 'as duas sessões são do MESMO grupo');
  const nova = async (nome) => (await admin.chamar('POST', '/people', { personType: 'PF', legalName: nome })).dados.id;
  const ids = { pessoaOk: await nova(`ACEITE-M9 roteiro ok ${SUF}`), pessoaOptOut: await nova(`ACEITE-M9 roteiro optout ${SUF}`), campanhaId: crypto.randomUUID(), fluxoId: null, modeloId: null };
  const rel = new Relato();
  await isolamento.executar({ rel, ids, admin, leitura, outra });
  const r = rel.paraJson();
  assert.deepEqual(r.conferencias.filter((c) => c.ok !== true).map((c) => `${c.descricao}: ${c.evidencia}`), []);
  assert.equal(r.resumo.ok, ESPERADAS_SEM_AUTOMACAO, `conferências: ${r.conferencias.map((c) => c.descricao).join(' | ')}`);
  for (const d of ['endereços', 'documentos', 'papéis', 'arquivo do documento', 'por id e por empresa', 'PERSON_TAX_ID_IN_GROUP']) {
    assert.ok(r.conferencias.some((c) => c.descricao.includes(d)), `o roteiro confere ${d}`);
  }
});

test('arquivo de segredos do roteiro: lê HOMO_* fora do repositório com chmod 600; recusa dentro de repositório e legível por outros', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'homo-segredos-'));
  const fora = path.join(dir, 'aceite.env');
  fs.writeFileSync(fora, '# segredos de teste\nHOMO_ADMIN_PASSWORD="senha de teste"\nexport HOMO_OUTRA_EMPRESA_MFA_SECRET=JBSWY3DPEHPK3PXP\n');
  fs.chmodSync(fora, 0o600);
  const env = carregarSegredos({ HOMO_SEGREDOS_ARQUIVO: fora, HOMO_ADMIN_EMAIL: 'admin@x.test', HOMO_ADMIN_PASSWORD: '' });
  assert.equal(env.HOMO_ADMIN_PASSWORD, 'senha de teste');
  assert.equal(env.HOMO_OUTRA_EMPRESA_MFA_SECRET, 'JBSWY3DPEHPK3PXP');
  assert.equal(carregarSegredos({ HOMO_SEGREDOS_ARQUIVO: fora, HOMO_ADMIN_PASSWORD: 'do ambiente' }).HOMO_ADMIN_PASSWORD, 'do ambiente', 'o ambiente vale primeiro');
  fs.chmodSync(fora, 0o644);
  assert.throws(() => carregarSegredos({ HOMO_SEGREDOS_ARQUIVO: fora }), /chmod 600/);
  const dentro = path.join(__dirname, `.segredos-teste-${SUF}.env`);
  fs.writeFileSync(dentro, 'HOMO_ADMIN_PASSWORD=x\n', { mode: 0o600 });
  try {
    assert.throws(() => carregarSegredos({ HOMO_SEGREDOS_ARQUIVO: dentro }), /dentro do repositório/);
  } finally {
    fs.rmSync(dentro, { force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.throws(() => carregarSegredos({ HOMO_SEGREDOS_ARQUIVO: path.join(os.tmpdir(), `nao-existe-${SUF}`) }), /não existe/);
});
