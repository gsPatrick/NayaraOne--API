'use strict';

// Busca da tool `knowledge.search` no índice do RAG (M9-D023): conhecimento homologado (D008), arquivos e URLs já indexados (D022), sempre
// com a empresa e a permissão do ATOR antes do conteúdo e dentro do teto do agente (`scope.execution`). O resultado volta como trecho
// curto e sem segredo; quem o usa o trata como `untrusted`.
const { RetrievalService } = require('../retrieval/RetrievalService');
const { maskSecrets } = require('../guards/secretPatterns');
const { ragPermissions } = require('../retrieval/retrieval.actor');

const LIMITE_PADRAO = 5;
const RESUMO_MAX = 300;
const service = new RetrievalService();

const versionOf = (item) => (Number.isInteger(Number(item.sourceVersion)) ? Number(item.sourceVersion) : 1);

function knowledge(transaction, scope) {
  return {
    async search(query, limit) {
      // A permissão do ator inteiro decide o que ele pode ver; a efetiva da NAY (só a das tools) não limita o RAG, e o teto do agente sim.
      const actor = {
        groupId: scope.groupId, companyId: scope.companyId, userId: scope.userId, permissions: ragPermissions(scope.userPermissions || scope.permissions || [], scope.actorType),
      };
      const found = await service.search(actor, query, { limit: limit || LIMITE_PADRAO, execution: scope.execution, lexicalOnly: scope.lexicalOnly === true }, transaction);
      return {
        items: found.items.map((i) => ({
          id: i.chunkId, title: `${i.sourceType} ${i.sourceId}`, version: versionOf(i), classification: i.classification, summary: maskSecrets(String(i.content || '')).slice(0, RESUMO_MAX),
        })),
      };
    },
  };
}

module.exports = { knowledge };
