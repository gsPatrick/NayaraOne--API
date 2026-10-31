'use strict';

const { sequelize } = require('../../../models');
const logger = require('../../../utils/logger');
const { userSectors } = require('../../core-governance/bcp/bcp.sectors');
const { flags } = require('../../core-governance/feature-flags');
const members = require('./canary.members');
const { selectedUsers } = require('./canary.selection');
const { flagKey } = require('./canary.constants');

/** O usuário está entre os selecionados do setor? 100% é todo o setor; 0% é ninguém; entre os dois vale a ordem estável por hash (M9-D904 §3.2). */
async function isSelected(tenant, userId, sector, percent, transaction) {
  if (percent <= 0) return false;
  if (percent >= 100) return true;
  return selectedUsers(await members.sectorMembers(tenant, sector, transaction), percent).includes(String(userId));
}

/**
 * Roteamento no login (M9-D904 §3.5): para cada setor do usuário, a flag do setor resolvida por `flags.resolve` (M9-D870) dá o percentual; quem está entre os selecionados
 * opera no sistema novo (`newSystem: true`), os demais continuam no antigo. Sem setor ou sem flag: sistema antigo.
 */
async function routeAtLogin(tenant, userId, transaction) {
  const sectors = [];
  for (const sector of await userSectors(userId, tenant, transaction)) {
     
    const resolved = await flags.resolve(tenant, flagKey(sector), { userId, sector }, transaction, { defaultValue: 0 });
    const percent = Number.isInteger(Number(resolved.value)) ? Number(resolved.value) : 0;
     
    sectors.push({ sector, percent, newSystem: await isSelected(tenant, userId, sector, percent, transaction) });
  }
  return { newSystem: sectors.some((item) => item.newSystem), sectors };
}

/**
 * O mesmo, para o login: dentro de um savepoint, para uma falha ao ler o registro nunca derrubar a transação do login nem impedir a entrada (o usuário segue no sistema antigo
 * e o erro vai ao log).
 */
async function routeForLogin(tenant, userId, transaction) {
  try {
    return await sequelize.transaction({ transaction }, (savepoint) => routeAtLogin(tenant, userId, savepoint));
  } catch (err) {
    logger.error({ err: { code: err.code, message: err.message } }, 'migration.canary.login_route_failed');
    return { newSystem: false, sectors: [], error: 'CANARY_ROUTE_UNAVAILABLE' };
  }
}

module.exports = { routeAtLogin, routeForLogin, isSelected };
