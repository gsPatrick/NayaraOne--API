'use strict';

const { Router } = require('express');
const { authMiddleware, requirePermission } = require('../../middlewares/auth.middleware');
const tenantMiddleware = require('../../middlewares/tenant.middleware');
const radarController = require('./radar.controller');
const carteira = require('../crm/carteira/carteira.guard');

const radarRouter = Router();

radarRouter.use(authMiddleware, tenantMiddleware);
// CRM-TS-012 / livro §18: radar fora da carteira do corretor de escopo próprio = 404; listagem só da carteira; criar com oportunidade alheia = 404.
radarRouter.use('/radar/:id', carteira.requireRecordInScope('radar'));

radarRouter.post('/radar', requirePermission('radar:create'), carteira.requireBodyOpportunityInScope, radarController.create);
radarRouter.get('/radar', requirePermission('radar:read'), carteira.attachCarteira, radarController.list);
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
