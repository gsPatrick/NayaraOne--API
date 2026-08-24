'use strict';

const catchAsync = require('../../utils/catchAsync');
const { success } = require('../../utils/httpResponse');
const groupsService = require('./groups.service');

const create = catchAsync(async (req, res) => {
  const group = await groupsService.createGroup(req.body, req.auth.userId);
  return success(res, { statusCode: 201, data: group });
});

const list = catchAsync(async (req, res) => {
  const groups = await groupsService.listGroups();
  return success(res, { data: groups });
});

const getOne = catchAsync(async (req, res) => {
  const group = await groupsService.getGroup(req.params.id);
  return success(res, { data: group });
});

const update = catchAsync(async (req, res) => {
  const group = await groupsService.updateGroup(req.params.id, req.body, req.auth.userId);
  return success(res, { data: group });
});

const remove = catchAsync(async (req, res) => {
  const result = await groupsService.deleteGroup(req.params.id, req.auth.userId);
  return success(res, { data: result });
});

module.exports = { create, list, getOne, update, remove };
