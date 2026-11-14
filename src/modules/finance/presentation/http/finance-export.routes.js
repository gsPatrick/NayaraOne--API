'use strict';

const { Router } = require('express');
const { authMiddleware, requirePermission } = require('../../../../middlewares/auth.middleware');
const tenantMiddleware = require('../../../../middlewares/tenant.middleware');
const { moved } = require('../../../../features/core-governance/dlp/exports/export.errors');

// Caderno Marco 4 §17: exportação financeira massiva exige MFA + auditoria + limite. Desde o M9-D822 todo arquivo sai por POST /exports (finalidade, justificativa, MFA,
// auditoria, expiração e marca d'água opcional); esta rota antiga só avisa para onde foi (410 GOV_EXPORT_MOVED), sem gerar nada. O gerador continua em finance-export.service.js,
// chamado pelo catálogo de exportações. Middlewares por rota (nunca router.use sem path — ver comentário em src/routes/index.js).
const financeExportRouter = Router();

financeExportRouter.get(
  '/finance/exports/entries',
  authMiddleware,
  tenantMiddleware,
  requirePermission('finance:read'),
  (_req, _res, next) => next(moved())
);

module.exports = financeExportRouter;
