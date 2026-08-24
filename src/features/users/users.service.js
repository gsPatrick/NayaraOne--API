'use strict';

const bcrypt = require('bcryptjs');
const { User } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');

const BCRYPT_ROUNDS = 12;

/**
 * "core"."users" é identidade global (sem RLS — um usuário pode ter memberships em múltiplas
 * empresas). password_hash nunca é serializado na resposta HTTP — ver `toSafeJson`.
 */
function toSafeJson(user) {
  const json = user.toJSON();
  delete json.passwordHash;
  return json;
}

// "core"."users" é global (sem groupId/companyId próprio — sem RLS), então a entrada de
// auditoria de ações sobre usuário é atribuída ao contexto de tenant de QUEM fez a ação
// (actorContext.groupId/companyId, vindo de req.auth de quem está logado como admin), não do
// usuário-alvo em si. Sem esse contexto (ex.: chamada de um script sem JWT), a auditoria é
// simplesmente pulada — nunca derruba a operação de negócio por falha de log.
async function createUser(payload, actorUserId, actorContext = {}) {
  const { name, email, password, mfaEnabled, mfaMethod, status } = payload;
  if (!name || !email || !password) {
    throw AppError.badRequest('Os campos "name", "email" e "password" são obrigatórios.', 'USER_VALIDATION');
  }
  if (password.length < 8) {
    throw AppError.badRequest('A senha deve ter ao menos 8 caracteres.', 'USER_WEAK_PASSWORD');
  }

  const existing = await User.findOne({ where: { email: email.toLowerCase().trim() } });
  if (existing) {
    throw AppError.conflict('Já existe um usuário com este e-mail.', 'USER_EMAIL_TAKEN');
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

  const user = await User.create({
    name,
    email: email.toLowerCase().trim(),
    passwordHash,
    mfaEnabled: Boolean(mfaEnabled),
    mfaMethod: mfaMethod || null,
    status: status || 'ACTIVE',
    createdBy: actorUserId || null,
    updatedBy: actorUserId || null,
  });

  if (actorContext.groupId && actorContext.companyId) {
    await registrarAuditoria({
      groupId: actorContext.groupId,
      companyId: actorContext.companyId,
      actorUserId,
      action: 'user.create',
      entityType: 'User',
      entityId: user.id,
      afterJson: toSafeJson(user),
      reason: `Usuário "${user.name}" (${user.email}) criado.`,
    });
  }

  return toSafeJson(user);
}

async function listUsers() {
  const users = await User.findAll({ order: [['created_at', 'DESC']] });
  return users.map(toSafeJson);
}

async function getUser(id) {
  const user = await User.findByPk(id);
  if (!user) throw AppError.notFound('Usuário não encontrado.', 'USER_NOT_FOUND');
  return user;
}

async function getUserSafe(id) {
  return toSafeJson(await getUser(id));
}

async function updateUser(id, payload, actorUserId, actorContext = {}) {
  const user = await getUser(id);
  const beforeJson = toSafeJson(user);
  const { name, status, mfaEnabled, mfaMethod, password } = payload;
  const statusChanged = status !== undefined && status !== user.status;
  if (name !== undefined) user.name = name;
  if (status !== undefined) user.status = status;
  if (mfaEnabled !== undefined) user.mfaEnabled = Boolean(mfaEnabled);
  if (mfaMethod !== undefined) user.mfaMethod = mfaMethod;
  if (password !== undefined) {
    if (password.length < 8) {
      throw AppError.badRequest('A senha deve ter ao menos 8 caracteres.', 'USER_WEAK_PASSWORD');
    }
    user.passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  }
  user.updatedBy = actorUserId || null;
  await user.save();

  if (actorContext.groupId && actorContext.companyId) {
    await registrarAuditoria({
      groupId: actorContext.groupId,
      companyId: actorContext.companyId,
      actorUserId,
      action: statusChanged ? 'user.status_change' : 'user.update',
      entityType: 'User',
      entityId: user.id,
      beforeJson,
      afterJson: toSafeJson(user),
      reason: statusChanged
        ? `Status do usuário "${user.name}" alterado para "${status}".`
        : `Usuário "${user.name}" atualizado.`,
    });
  }

  return toSafeJson(user);
}

async function deleteUser(id, actorUserId, actorContext = {}) {
  const user = await getUser(id);
  const beforeJson = toSafeJson(user);
  user.deletedBy = actorUserId || null;
  await user.save();
  await user.destroy();

  if (actorContext.groupId && actorContext.companyId) {
    await registrarAuditoria({
      groupId: actorContext.groupId,
      companyId: actorContext.companyId,
      actorUserId,
      action: 'user.delete',
      entityType: 'User',
      entityId: id,
      beforeJson,
      reason: `Usuário "${user.name}" (${user.email}) excluído.`,
    });
  }

  return { id };
}

module.exports = { createUser, listUsers, getUser, getUserSafe, updateUser, deleteUser, toSafeJson };
