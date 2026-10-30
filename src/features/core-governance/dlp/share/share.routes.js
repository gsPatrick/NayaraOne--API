'use strict';

const { Router } = require('express');
const catchAsync = require('../../../../utils/catchAsync');
const { EXPORT_PERMISSION, ADMIN_PERMISSION } = require('../dlp.constants');
const { requireIdempotencyKey } = require('../idempotency.header');
const controller = require('./share.controller');
const { confirmAction } = require('../../../../shared/destructive-actions/guard'); // M9-D852 linha 12

/** Rotas autenticadas dos links (montadas por dlp.routes.js dentro do módulo /dlp): criar com Idempotency-Key, listar e revogar. */
const SHARE_ROUTES = [
  { method: 'post', path: '/dlp/share-links', permission: EXPORT_PERMISSION, after: [requireIdempotencyKey], handler: controller.create },
  { method: 'get', path: '/dlp/share-links', permission: [EXPORT_PERMISSION, ADMIN_PERMISSION], handler: controller.list },
  { method: 'post', path: '/dlp/share-links/:id/revoke', permission: EXPORT_PERMISSION, after: [confirmAction('dlp.share_link.revoke')], handler: controller.revoke },
];

/** Rota PÚBLICA, sem login e sem tenant: a empresa é resolvida pelo hash do token (M9-D823 §3 item 4). */
const publicRouter = Router();
publicRouter.get('/public/share/:token', catchAsync(controller.publicAccess));

module.exports = { SHARE_ROUTES, publicRouter };
