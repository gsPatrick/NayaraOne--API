'use strict';

const { requirePermission } = require('../../../middlewares/auth.middleware');
const { aiGate } = require('../aiGate.middleware');
const { anyOf } = require('../anyOf');
const c = require('./ingestion.controller');

/** Indexação é da empresa toda, não de um agente: só a chave geral da NAY vale. */
const gate = aiGate({ agentParam: '__sem_agente__' });

/**
 * Rotas da ingestão do RAG, no router de /v1/ai (que já aplicou autenticação e tenant). A autorização fina (`ai:admin` ou dono do arquivo
 * com `ai:use`) é do serviço, porque depende do arquivo; a classificação do arquivo é de `ai:admin` COM `governance:classification:manage` (M9-D920: a classe do anexo só muda por quem tem essa permissão; baixar o nível de um anexo
 * RESTRICTED liberaria o download dele).
 */
function registerIngestionRoutes(router) {
  router.post('/ai/ingestions', anyOf('ai:use', 'ai:admin'), gate, c.create);
  router.get('/ai/ingestions/:id', anyOf('ai:use', 'ai:audit', 'ai:admin'), gate, c.getOne);
  router.put('/ai/files/:fileId/classification', requirePermission('ai:admin'), requirePermission('governance:classification:manage'), gate, c.classify);
}

module.exports = { registerIngestionRoutes };
