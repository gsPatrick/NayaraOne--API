'use strict';

const { Router } = require('express');
const { authMiddleware, requirePermission } = require('../../middlewares/auth.middleware');
const tenantMiddleware = require('../../middlewares/tenant.middleware');
const crmController = require('./crm.controller');
const radarController = require('../radar/radar.controller');
const livro = require('./crm.livroApi.controller');

/**
 * Guia do Marcelo §13 "APIs mínimas" do Marco 3, no caminho exato do livro. Os caminhos de sempre continuam valendo
 * (o Front usa /opportunities, /messages, /visits, /radar e /crm/feedback-cases); estes delegam aos mesmos services.
 * Só caminhos sob /crm, para não capturar requisições de outros módulos.
 */
const crmLivroRouter = Router();
const scoped = [authMiddleware, tenantMiddleware];

// §18: troca de responsável em massa com permissão específica (antes de '/crm/opportunities/:id/...').
crmLivroRouter.post('/crm/opportunities/reassign', scoped, requirePermission('crm:opportunities:reassign'), livro.reassignOwners);
crmLivroRouter.post('/crm/opportunities', scoped, requirePermission('crm:opportunities:create'), crmController.createOpportunity);
crmLivroRouter.post('/crm/opportunities/:id/interactions', scoped, requirePermission('crm:messages:create'), livro.recordInteraction);
crmLivroRouter.post('/crm/opportunities/:id/visits', scoped, requirePermission('crm:visits:create'), livro.scheduleVisit);
crmLivroRouter.post('/crm/opportunities/:id/lost', scoped, requirePermission('crm:opportunities:update'), livro.markLost);
crmLivroRouter.post('/crm/radars', scoped, requirePermission('radar:create'), radarController.create);
crmLivroRouter.get('/crm/radars/:id/matches', scoped, requirePermission('radar:read'), radarController.matches);
crmLivroRouter.post('/crm/occurrences', scoped, requirePermission('crm:feedback:create'), crmController.createFeedbackCase);
crmLivroRouter.delete('/crm/occurrences/:id', scoped, requirePermission('crm:feedback:update'), livro.refuseOccurrenceDeletion);
crmLivroRouter.delete('/crm/feedback-cases/:id', scoped, requirePermission('crm:feedback:update'), livro.refuseOccurrenceDeletion);

module.exports = crmLivroRouter;
