'use strict';

const { userSectors } = require('./bcp.sectors');
const templates = require('./formTemplates.repository');

/** Lista os modelos dos formulários dos setores do usuário (M9-D834 §3.1: leitura só de quem é do setor); `sector` opcional restringe a um setor. */
async function listForUser({ tenant, actorUserId, query = {}, transaction }) {
  const mine = await userSectors(actorUserId, tenant, transaction);
  const sectors = query.sector ? mine.filter((sector) => sector === query.sector) : mine;
  if (!sectors.length) return [];
  return templates.listTemplates(transaction, sectors);
}

module.exports = { listForUser };
