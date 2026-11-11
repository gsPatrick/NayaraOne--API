'use strict';

const { Router } = require('express');
const { authMiddleware, requirePermission } = require('../../middlewares/auth.middleware');
const tenantMiddleware = require('../../middlewares/tenant.middleware');
const radarController = require('./radar.controller');

const radarRouter = Router();

radarRouter.use(authMiddleware, tenantMiddleware);

radarRouter.post('/radar', requirePermission('radar:create'), radarController.create);
radarRouter.get('/radar', requirePermission('radar:read'), radarController.list);
radarRouter.get('/radar/:id', requirePermission('radar:read'), radarController.getOne);
radarRouter.patch('/radar/:id', requirePermission('radar:update'), radarController.update);
radarRouter.delete('/radar/:id', requirePermission('radar:delete'), radarController.remove);
radarRouter.get('/radar/:id/matches', requirePermission('radar:read'), radarController.matches);
// Marco 3 §13 / Guia §9 — matches gravados (crm.radar_matches) com score, critérios, impressão digital e versão.
radarRouter.get('/radar/:id/match-history', requirePermission('radar:read'), radarController.matchHistory);
// M3-15 — explicação dos critérios do Radar para um imóvel específico.
radarRouter.get(
  '/radar/:id/matches/:propertyId/explain',
  requirePermission('radar:read'),
  radarController.explainMatch
);

module.exports = radarRouter;
