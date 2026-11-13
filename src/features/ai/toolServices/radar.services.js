'use strict';

// Radar para as tools da NAY (M9-D016/D034): os imóveis compatíveis já calculados pelo Radar, com pontuação e motivo, cortados em
// `ia.comercial.radar_max_imoveis` quando a tool não pede um limite.
const { listRadarMatches } = require('../agents/nay_comercial/comercial.radar');
const { readComercialParams } = require('../agents/nay_comercial/comercial.params');
const { scopeOfToolScope } = require('../agents/nay_comercial/comercial.scope');

function radarMatches(transaction, scope = {}) {
  return {
    async listForOpportunity(opportunityId, limit) {
      const params = await readComercialParams({ groupId: scope.groupId, companyId: scope.companyId }, transaction);
      // Escopo de carteira (livro do Marco 3 §18): oportunidade de outro corretor é "não encontrado".
      const list = await listRadarMatches(opportunityId, transaction, { limit: limit || params.radarMax, ownerScope: scopeOfToolScope(scope) });
      return { opportunityId: list.opportunityId, radars: list.radars, total: list.total, hasMore: list.hasMore, extra: list.extra, matches: list.matches };
    },
  };
}

module.exports = { radarMatches };
