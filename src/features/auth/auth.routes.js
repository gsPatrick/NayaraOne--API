'use strict';

const { Router } = require('express');
const { authMiddleware } = require('../../middlewares/auth.middleware');
const authController = require('./auth.controller');

const authRouter = Router();

// Rotas de auth são públicas por definição (não exigem auth.middleware) — são o próprio
// ponto de entrada da autenticação.
// Rodada 7 (DI-M9R-21): tipo dos campos conferido na porta (antes, `email` com um objeto dava 500).
authRouter.post('/auth/login', require('./auth.schema').validarLogin, authController.login);
authRouter.post('/auth/refresh', authController.refresh);
authRouter.post('/auth/logout', authController.logout);

// Autenticadas (R9): listar empresas com vínculo ativo e trocar de empresa.
authRouter.get('/auth/companies', authMiddleware, authController.listCompanies);
authRouter.post('/auth/switch-company', authMiddleware, authController.switchCompany);

module.exports = authRouter;
