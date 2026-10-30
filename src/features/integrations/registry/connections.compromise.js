'use strict';

const { Op } = require('sequelize');
const { IntegrationConnection, IntegrationProvider } = require('../../../models');
const { getServerEnvironment } = require('./registry.helpers');
const { transitionConnection } = require('./connections.transition');

const LIVE = ['ACTIVE', 'PAUSED', 'AUTH_FAILED'];

/**
 * M9-D433 — conta comprometida: marca COMPROMISED todas as conexões vivas (ACTIVE, PAUSED, AUTH_FAILED) da família (domínio) no ambiente do servidor, como ação do
 * sistema (sem MFA: bloquear nunca deve esperar). Devolve [{ id, providerCode, from }]; sem conexão (só sandbox) devolve lista vazia. Na transação do chamador.
 */
async function compromiseDomainConnections({ companyId, groupId, userId = null, domain, reason, transaction }) {
  const providers = await IntegrationProvider.findAll({ where: { domain }, attributes: ['code'], transaction });
  if (providers.length === 0) return [];
  const rows = await IntegrationConnection.findAll({
    where: { companyId, environment: getServerEnvironment(), status: { [Op.in]: LIVE }, providerCode: { [Op.in]: providers.map((p) => p.code) } },
    order: [['created_at', 'ASC'], ['id', 'ASC']], transaction,
  });
  const marked = [];
  for (const row of rows) {
    const from = row.status;
    await transitionConnection(row.id, 'COMPROMISED', { companyId, groupId, userId }, transaction, { system: true, reason });
    marked.push({ id: row.id, providerCode: row.providerCode, from });
  }
  return marked;
}

module.exports = { compromiseDomainConnections };
