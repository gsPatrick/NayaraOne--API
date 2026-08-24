'use strict';

const { Router } = require('express');
const authController = require('./auth.controller');

const authRouter = Router();

// Rotas de auth são públicas por definição (não exigem auth.middleware) — são o próprio
// ponto de entrada da autenticação.
authRouter.post('/auth/login', authController.login);
authRouter.post('/auth/refresh', authController.refresh);
authRouter.post('/auth/logout', authController.logout);

module.exports = authRouter;
