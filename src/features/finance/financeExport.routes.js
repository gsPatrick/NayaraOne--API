'use strict';

const { Router } = require('express');
const { authMiddleware, requirePermission, requireRecentMfa } = require('../../middlewares/auth.middleware');
const tenantMiddleware = require('../../middlewares/tenant.middleware');
const catchAsync = require('../../utils/catchAsync');
const { exportFinancialEntries } = require('./financeExport.service');

// Caderno Marco 4 §17: exportação financeira massiva exige MFA + auditoria + limite.
// Middlewares por rota (nunca router.use sem path — ver comentário em src/routes/index.js).
const financeExportRouter = Router();

financeExportRouter.get(
  '/finance/exports/entries',
  authMiddleware,
  tenantMiddleware,
  requirePermission('finance:read'),
  requireRecentMfa,
  catchAsync(async (req, res) => {
    const result = await req.withTenantTransaction((t) =>
      exportFinancialEntries(
        { groupId: req.auth.groupId, companyId: req.auth.companyId, userId: req.auth.userId },
        { competenceMonth: req.query.competenceMonth, nature: req.query.nature, status: req.query.status },
        t
      )
    );
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', 'attachment; filename="lancamentos.csv"');
    res.set('X-Export-Rows', String(result.rows));
    res.set('X-Export-Sha256', result.sha256);
    return res.status(200).send(result.csv);
  })
);

module.exports = financeExportRouter;
