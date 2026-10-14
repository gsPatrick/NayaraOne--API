'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');

const { sequelize, getSeedTenant, uniqueSuffix } = require('./testHelpers');
const usersService = require('../src/features/users/users.service');
const { User } = require('../src/models');
const AppError = require('../src/utils/AppError');

let tenant;

before(async () => {
  tenant = await getSeedTenant();
});

after(async () => {
  await sequelize.close();
});

async function createTargetUser(suffix) {
  const user = await User.create({
    name: `AUDIT SetPassword ${suffix}`,
    email: `audit-set-password-${suffix}@nayaraone.dev`,
    passwordHash: 'x',
    status: 'ACTIVE',
  });
  return user.id;
}

// USERS-SETPASS-001 — garante que a funcionalidade adicionada em 14/10/2026 (achado real da
// rodada 4 de auditoria da Nayara, M4-R01: não havia nenhum jeito de um usuário novo receber
// uma senha — nem admin-set, nem convite — então nenhum segundo aprovador conseguia logar para
// testar o fluxo de maker-checker) funciona e fica protegida.

test('USERS-SETPASS-001 define senha nova e ela passa a autenticar (hash bcrypt válido)', async () => {
  const suffix = uniqueSuffix();
  const userId = await createTargetUser(suffix);
  await usersService.setUserPassword(userId, 'SenhaForte#123', null, tenant);

  const user = await User.findByPk(userId);
  const matches = await bcrypt.compare('SenhaForte#123', user.passwordHash);
  assert.equal(matches, true);

  await user.destroy({ force: true });
});

test('USERS-SETPASS-002 rejeita senha curta (menos de 8 caracteres)', async () => {
  const suffix = uniqueSuffix();
  const userId = await createTargetUser(suffix);
  try {
    await assert.rejects(
      () => usersService.setUserPassword(userId, '123', null, tenant),
      (err) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'USER_WEAK_PASSWORD');
        return true;
      }
    );
  } finally {
    const user = await User.findByPk(userId);
    await user.destroy({ force: true });
  }
});
