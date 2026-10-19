'use strict';

const catchAsync = require('../../utils/catchAsync');
const { success } = require('../../utils/httpResponse');
const usersService = require('./users.service');
const { UserMembership } = require('../../models');

const create = catchAsync(async (req, res) => {
  const user = await usersService.createUser(req.body, req.auth.userId, {
    groupId: req.auth.groupId,
    companyId: req.auth.companyId,
  });
  return success(res, { statusCode: 201, data: user });
});

// users:read é concedido a perfis operacionais só para resolver nomes (custodiante, responsável,
// autor). E-mail e demais dados de cadastro ficam restritos a quem administra usuários
// (users:update): o aprovador de Compras via a lista inteira de usuários com e-mail no Painel
// (auditoria Marco 7 "final2", 18/10/2026).
function canSeeUserDetails(req) {
  return (req.auth?.permissions || []).includes('users:update') || req.auth?.userId === req.params?.id;
}

function toPublicUser(user) {
  const plain = typeof user?.toJSON === 'function' ? user.toJSON() : user;
  return { id: plain.id, name: plain.name, status: plain.status };
}

const list = catchAsync(async (req, res) => {
  const users = await usersService.listUsers({ status: req.query.status });
  if (canSeeUserDetails(req)) return success(res, { data: users });
  // core.users é global (identidade, sem RLS): para quem não administra usuários, a lista se
  // limita a quem tem vínculo com a empresa da sessão — é o universo de responsáveis possíveis.
  const memberships = await req.withTenantTransaction((transaction) => UserMembership.findAll({
    where: { companyId: req.auth.companyId },
    attributes: ['userId'],
    transaction,
  }));
  const companyUserIds = new Set(memberships.map((m) => m.userId));
  return success(res, { data: users.filter((u) => companyUserIds.has(u.id)).map(toPublicUser) });
});

const getOne = catchAsync(async (req, res) => {
  const user = await usersService.getUserSafe(req.params.id);
  return success(res, { data: canSeeUserDetails(req) ? user : toPublicUser(user) });
});

const update = catchAsync(async (req, res) => {
  const user = await usersService.updateUser(req.params.id, req.body, req.auth.userId, {
    groupId: req.auth.groupId,
    companyId: req.auth.companyId,
  });
  return success(res, { data: user });
});

const remove = catchAsync(async (req, res) => {
  const result = await usersService.deleteUser(req.params.id, req.auth.userId, {
    groupId: req.auth.groupId,
    companyId: req.auth.companyId,
  });
  return success(res, { data: result });
});

const setPassword = catchAsync(async (req, res) => {
  const user = await usersService.setUserPassword(req.params.id, req.body.password, req.auth.userId, {
    groupId: req.auth.groupId,
    companyId: req.auth.companyId,
  });
  return success(res, { data: user });
});

module.exports = { create, list, getOne, update, remove, setPassword };
