'use strict';

const { Router } = require('express');
const { authMiddleware } = require('../../middlewares/auth.middleware');
const tenantMiddleware = require('../../middlewares/tenant.middleware');
const filesController = require('./files.controller');

const filesRouter = Router();

filesRouter.use(authMiddleware, tenantMiddleware);

// Sem permissão dedicada de propósito: upload/download de File é uma utilidade transversal
// (usada por vistorias, contratos, pessoas etc.), o mesmo padrão de "qualquer usuário
// autenticado do tenant pode anexar um arquivo" já implícito nos fluxos que criam File hoje
// (ex.: contractVersions.service.js não checa uma permissão "files:create" separada).
filesRouter.post('/files', filesController.uploadFile);
filesRouter.get('/files/:id/content', filesController.downloadFile);

module.exports = filesRouter;
