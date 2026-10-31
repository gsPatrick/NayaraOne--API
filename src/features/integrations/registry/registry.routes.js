'use strict';

const { Router } = require('express');
const { authMiddleware, requirePermission } = require('../../../middlewares/auth.middleware');
const tenantMiddleware = require('../../../middlewares/tenant.middleware');
const controller = require('./registry.controller');
const { confirmAction } = require('../../../shared/destructive-actions/guard'); // M9-D852 linha 17

// Registro de integração (M9-D200). As listagens por fornecedor/saúde (`/admin/integrations/:provider/...`)
// são da M9-D249; aqui ficam só os caminhos do registro, sob `/admin/integrations/registry`.
const registryRouter = Router();
registryRouter.use(authMiddleware, tenantMiddleware);

// O catálogo de fornecedores é GLOBAL (vale para todas as empresas): escrever nele exige integration:platform, que nenhum papel de empresa recebe por padrão (M9-D200, reabertura M1).
const base = '/admin/integrations/registry';
registryRouter.get(`${base}/providers`, requirePermission('integration:read'), controller.listProviders);
registryRouter.post(`${base}/providers`, requirePermission('integration:platform'), controller.createProvider);
registryRouter.patch(`${base}/providers/:code`, requirePermission('integration:platform'), controller.updateProvider);

registryRouter.get(`${base}/connections`, requirePermission('integration:read'), controller.listConnections);
registryRouter.post(`${base}/connections`, requirePermission('integration:manage'), controller.createConnection);
registryRouter.get(`${base}/connections/:id`, requirePermission('integration:read'), controller.getConnection);
registryRouter.patch(`${base}/connections/:id`, requirePermission('integration:manage'), controller.updateConnection);
registryRouter.post(`${base}/connections/:id/transition`, requirePermission('integration:manage'), confirmAction('integration.connection.disable', { mfa: true }), controller.transitionConnection);
registryRouter.post(`${base}/connections/:id/swap`, requirePermission('integration:manage'), controller.swapConnection);

// M9-D256: liberação para produção por connection (a rota do livro `/admin/integrations/connections/:id/release` responde igual) e estado do portão por fornecedor.
registryRouter.post(`${base}/connections/:id/release`, requirePermission('integration:manage'), controller.releaseConnection);
registryRouter.post('/admin/integrations/connections/:id/release', requirePermission('integration:manage'), controller.releaseConnection);
registryRouter.get(`${base}/release-gate`, requirePermission('integration:read'), controller.getReleaseGate);

module.exports = registryRouter;
