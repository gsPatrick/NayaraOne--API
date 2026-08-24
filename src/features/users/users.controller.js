'use strict';

const catchAsync = require('../../utils/catchAsync');
const { success } = require('../../utils/httpResponse');
const usersService = require('./users.service');

const create = catchAsync(async (req, res) => {
  const user = await usersService.createUser(req.body, req.auth.userId, {
    groupId: req.auth.groupId,
    companyId: req.auth.companyId,
  });
  return success(res, { statusCode: 201, data: user });
});

const list = catchAsync(async (req, res) => {
  const users = await usersService.listUsers();
  return success(res, { data: users });
});

const getOne = catchAsync(async (req, res) => {
  const user = await usersService.getUserSafe(req.params.id);
  return success(res, { data: user });
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

module.exports = { create, list, getOne, update, remove };
