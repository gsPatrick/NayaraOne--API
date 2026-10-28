'use strict';

const opportunityService = require('../../crm/opportunity.service');
const radarService = require('../../radar/radar.service');

const LIMITE_PADRAO = 10;

function radarMatches(transaction) {
  return {
    async listForOpportunity(opportunityId, limit) {
      const oportunidade = await opportunityService.getOpportunity(opportunityId, transaction);
      const radars = (await radarService.listRadars(transaction, { personId: oportunidade.personId })).filter((r) => r.opportunityId === opportunityId);
      const matches = [];
      for (const radar of radars) {
        for (const imovel of await radarService.getRadarMatches(radar.id, transaction)) {
          matches.push({ propertyId: imovel.id, radarId: radar.id, score: null, title: imovel.title ?? null });
        }
      }
      return { opportunityId, radars: radars.length, matches: matches.slice(0, limit || LIMITE_PADRAO) };
    },
  };
}

module.exports = { radarMatches };
