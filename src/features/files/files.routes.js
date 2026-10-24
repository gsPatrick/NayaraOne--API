'use strict';

const { Router } = require('express');
const { authMiddleware } = require('../../middlewares/auth.middleware');
const tenantMiddleware = require('../../middlewares/tenant.middleware');
const filesController = require('./files.controller');

const filesRouter = Router();

filesRouter.use(authMiddleware, tenantMiddleware);

// Upload continua sem permissão dedicada: é uma utilidade transversal (vistorias, contratos,
// pessoas etc.) e o vínculo do arquivo é sempre feito por uma rota do módulo, que tem a sua
// própria permissão. LEITURA (metadado e conteúdo) não é mais livre: o controller exige a
// permissão de leitura de um módulo dono do arquivo ou ser quem fez o upload — ver
// fileAccess.service.js (RBAC-02, auditoria Nayara 18/10/2026).
filesRouter.post('/files', filesController.uploadFile);
filesRouter.get('/files/:id', filesController.getFileMetadata);
filesRouter.get('/files/:id/content', filesController.downloadFile);

module.exports = filesRouter;
