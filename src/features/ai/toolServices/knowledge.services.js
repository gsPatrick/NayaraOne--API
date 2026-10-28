'use strict';

// Busca na base de conhecimento HOMOLOGADA, vigente e ativa (M9-D008). Conteúdo RESTRICTED só para quem tem ai:restricted.
const knowledgeRegistry = require('../knowledge/knowledgeRegistry.service');
const { maskSecrets } = require('../guards/secretPatterns');

const LIMITE_PADRAO = 5;
const RESUMO_MAX = 300;

function knowledge(transaction, scope) {
  return {
    async search(query, limit) {
      const termos = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
      const agora = Date.now();
      const entradas = await knowledgeRegistry.listEntries(scope, { status: 'HOMOLOGATED' }, transaction);
      const vistas = entradas.filter((e) => e.isActive
        && (!e.validUntil || new Date(e.validUntil).getTime() > agora)
        && (e.classification !== 'RESTRICTED' || (scope.permissions || []).includes('ai:restricted'))
        && termos.every((t) => `${e.title} ${e.factKey}`.toLowerCase().includes(t)));
      return {
        items: vistas.slice(0, limit || LIMITE_PADRAO).map((e) => ({
          id: e.id, title: e.title, version: e.version, classification: e.classification,
          summary: maskSecrets(typeof e.value === 'string' ? e.value : JSON.stringify(e.value ?? '')).slice(0, RESUMO_MAX),
        })),
      };
    },
  };
}

module.exports = { knowledge };
