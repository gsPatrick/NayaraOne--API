'use strict';

const AppError = require('../../../utils/AppError');
const { requirePermission } = require('../../../middlewares/auth.middleware');
const { aiGate } = require('../aiGate.middleware');
const c = require('./agents.controller');

/** Gestão de versões é da empresa toda, não de um agente: só a chave geral da NAY vale (não a lista `ai.agents.enabled`). */
const gate = aiGate({ agentParam: '__sem_agente__' });

/** Aceita quem tem QUALQUER uma das permissões (a matriz de permissões lê `requiredPermission`). */
function anyOf(...codes) {
  const middleware = (req, res, next) => {
    if (!req.auth) return next(AppError.unauthorized('Contexto de autenticação ausente.', 'AUTH_CONTEXT_MISSING'));
    if (!codes.some((code) => req.auth.permissions.includes(code))) {
      return next(AppError.forbidden('Você não tem permissão para realizar esta ação. Peça o acesso a quem administra o seu perfil.', 'PERMISSION_DENIED', { required: codes.join('|'), alternatives: codes }));
    }
    return next();
  };
  middleware.requiredPermission = codes.join('|');
  return middleware;
}

/** Monta as rotas de agentes versionados no router de /v1/ai (que já aplicou autenticação e tenant sob /ai). */
function registerAgentRoutes(router) {
  const base = '/ai/agents';
  router.get(base, requirePermission('ai:use'), gate, c.listActive);
  router.get(`${base}/:code/versions`, anyOf('ai:admin', 'ai:evaluate'), gate, c.listVersions);
  router.get(`${base}/:code/versions/:version`, anyOf('ai:admin', 'ai:evaluate'), gate, c.getVersion);
  router.post(`${base}/:code/versions`, requirePermission('ai:admin'), gate, c.createVersion);
  router.patch(`${base}/:code/versions/:version`, requirePermission('ai:admin'), gate, c.updateDraft);
  router.put(`${base}/:code/versions/:version/tools`, requirePermission('ai:admin'), gate, c.setTools);
  router.post(`${base}/:code/versions/:version/homologate`, requirePermission('ai:evaluate'), gate, c.homologate);
  router.post(`${base}/:code/versions/:version/activate`, requirePermission('ai:admin'), gate, c.activate);
  router.put(`${base}/:code/versions/:version/activate`, requirePermission('ai:admin'), gate, c.activate);
  router.post(`${base}/:code/versions/:version/retire`, requirePermission('ai:admin'), gate, c.retire);
}

module.exports = { registerAgentRoutes };
