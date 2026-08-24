'use strict';

const { Router } = require('express');
const { authMiddleware, requirePermission } = require('../../middlewares/auth.middleware');
const usersController = require('./users.controller');

const usersRouter = Router();

usersRouter.use(authMiddleware);

usersRouter.post('/users', requirePermission('users:create'), usersController.create);
usersRouter.get('/users', requirePermission('users:read'), usersController.list);
usersRouter.get('/users/:id', requirePermission('users:read'), usersController.getOne);
usersRouter.patch('/users/:id', requirePermission('users:update'), usersController.update);
usersRouter.delete('/users/:id', requirePermission('users:delete'), usersController.remove);

module.exports = usersRouter;
