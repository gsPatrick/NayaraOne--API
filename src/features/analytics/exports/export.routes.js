'use strict';

/**
 * M9-D701 — POST /analytics/exports (analytics:export; pedido assíncrono, 202), GET /analytics/exports/:id/download (analytics:export; só o solicitante;
 * emite o endereço assinado curto) e GET /analytics/exports/:id/file (o endereço emitido; entrega o CSV). A rota de entrega não está entre as seis do Guia: o
 * livro pede URL temporária e não nomeia a rota (regra inferida do contexto, M9-D701 3.4). Registradas DEPOIS da guarda de método e da transação somente leitura
 * (M9-D612); o POST é uma das escritas de usuário permitidas ao BI (ANALYTICS_WRITE_ROUTES). Resposta de download nunca vai para cache.
 */
const catchAsync = require('../../../utils/catchAsync');
const { success } = require('../../../utils/httpResponse');
const { P } = require('../security/permissionCatalog');
const { requireAnalyticsPermission } = require('../security/permissionGuard');
const { requestExport } = require('./export.request');
const { issueDownload, serveFile } = require('./export.download');

const ctxOf = (req) => ({ groupId: req.auth.groupId, companyId: req.auth.companyId, actorUserId: req.auth.userId, permissions: req.auth.permissions });
const noCache = (res) => res.set({ 'Cache-Control': 'no-store, private', Pragma: 'no-cache', Expires: '0' });

function registerExportRoutes(router) {
  router.post('/analytics/exports', requireAnalyticsPermission(P.EXPORT), catchAsync(async (req, res) => {
    const data = await req.withTenantTransaction((tx) => requestExport(ctxOf(req), req.body, { ip: req.ip, route: 'POST /analytics/exports' }, tx));
    noCache(res);
    return success(res, { statusCode: 202, data });
  }));
  router.get('/analytics/exports/:id/download', requireAnalyticsPermission(P.EXPORT), catchAsync(async (req, res) => {
    const data = await issueDownload(ctxOf(req), req.params.id, { ip: req.ip, route: 'GET /analytics/exports/:id/download' });
    noCache(res);
    return success(res, { data });
  }));
  router.get('/analytics/exports/:id/file', requireAnalyticsPermission(P.EXPORT), catchAsync(async (req, res) => {
    const file = await req.withTenantTransaction((tx) => serveFile(ctxOf(req), req.params.id, { exp: req.query.exp, sig: req.query.sig }, tx));
    noCache(res);
    res.set({ 'Content-Type': file.mimeType, 'Content-Disposition': `attachment; filename="${file.fileName.replace(/[^A-Za-z0-9._-]/g, '_')}"`, 'X-Content-Type-Options': 'nosniff' });
    return res.status(200).send(file.buffer);
  }));
}

module.exports = { registerExportRoutes };
