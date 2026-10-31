'use strict';

const { Router } = require('express');
const { authMiddleware, requirePermission } = require('../../middlewares/auth.middleware');
const tenantMiddleware = require('../../middlewares/tenant.middleware');
const filesController = require('./files.controller');
const downloads = require('../core-governance/dlp/downloads/download.controller');
const attachments = require('../core-governance/dlp/downloads/attachment.controller');

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

// DLP de anexos e downloads (M9-D920): o download explícito (HIGH/RESTRICTED devolvem o endereço assinado de uso único), o lote (zip), a entrega do endereço e a classe do anexo.
filesRouter.post('/files/download-batch', downloads.postBatch);
filesRouter.get('/files/downloads/:jobId', downloads.getGranted);
filesRouter.get('/files/:id/download', downloads.getDownload);
filesRouter.put('/files/:id/classification', requirePermission('governance:classification:manage'), attachments.putClassification);

module.exports = filesRouter;
