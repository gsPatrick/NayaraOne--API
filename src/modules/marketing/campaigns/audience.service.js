'use strict';

const audienceRepo = require('./audience.repository');
const { crossCompany } = require('./campaigns.errors');

/**
 * Valida as audiências de um rascunho antes de gravar qualquer coisa: pessoa de outra empresa (ou que não existe para esta
 * empresa; a RLS esconde a linha alheia, então as duas situações são indistinguíveis e ambas são recusadas) ou filtro que aponta
 * para outra empresa: 422 MKT_AUDIENCE_CROSS_COMPANY, nenhuma linha gravada. Os detalhes não revelam quem é a pessoa.
 */
async function assertAudiencesInCompany(audiences, tenant, transaction) {
  for (const audience of audiences) {
    if (audience.claimedCompanyId && audience.claimedCompanyId.toLowerCase() !== String(tenant.companyId).toLowerCase()) {
      throw crossCompany({ kind: audience.kind, reason: 'FILTER_COMPANY' });
    }
    if (audience.kind === 'PERSON_LIST') {
      const ids = audience.filter.personIds;
      const visible = await audienceRepo.countVisiblePersons(ids, tenant, transaction);
      if (visible !== ids.length) throw crossCompany({ kind: audience.kind, invalid: ids.length - visible });
    }
  }
}

async function saveDraftAudiences(campaignId, audiences, tenant, actor, transaction) {
  await assertAudiencesInCompany(audiences, tenant, transaction);
  await audienceRepo.replaceAudiences(campaignId, audiences.map(({ kind, purpose, filter }) => ({ kind, purpose, filter })), tenant, actor, transaction);
}

/** Ao agendar: congela cada audiência (materializa as pessoas) e devolve o total de pessoas distintas. */
async function freezeAll(campaignId, tenant, actor, now, transaction) {
  for (const audience of await audienceRepo.listAudiences(campaignId, tenant, transaction)) {
    await audienceRepo.freezeAudience(audience, tenant, actor, now, transaction);
  }
  return audienceRepo.countDistinctMembers(campaignId, tenant, transaction);
}

module.exports = { assertAudiencesInCompany, saveDraftAudiences, freezeAll };
