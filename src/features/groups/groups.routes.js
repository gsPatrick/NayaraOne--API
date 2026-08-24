'use strict';

const { Router } = require('express');
const { authMiddleware, requirePermission } = require('../../middlewares/auth.middleware');
const groupsController = require('./groups.controller');

const groupsRouter = Router();

groupsRouter.use(authMiddleware);

groupsRouter.post('/groups', requirePermission('groups:create'), groupsController.create);
groupsRouter.get('/groups', requirePermission('groups:read'), groupsController.list);
groupsRouter.get('/groups/:id', requirePermission('groups:read'), groupsController.getOne);
groupsRouter.patch('/groups/:id', requirePermission('groups:update'), groupsController.update);
groupsRouter.delete('/groups/:id', requirePermission('groups:delete'), groupsController.remove);

module.exports = groupsRouter;
