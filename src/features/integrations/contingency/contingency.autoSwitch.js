'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');
const logger = require('../../../utils/logger');
const { PORTS } = require('../providers/ports');
const { QUEUED_STATUSES } = require('./contingency.constants');
const { isAlternateSafe } = require('./contingency.alternateSafe');
const { switchToAlternate } = require('./contingency.switch');
const { alternateSqlFilter } = require('./contingency.domainHooks');

/** Nomes das operações do port da família em que a troca automática é permitida. */
function safeOperations(domain) {
  const port = PORTS[domain];
  if (!port) return [];
  return Object.entries(port.operations).filter(([nome, def]) => isAlternateSafe(domain, nome, def)).map(([nome]) => nome);
}

/**
 * Troca para o alternativo, sozinha, os envios da fila cuja operação é `alternate_safe` (M9-D226 3.3 item 2). A perigosa fica na fila até uma pessoa aprovar.
 * Cada troca roda num savepoint: a que falha não derruba as outras. Devolve a lista de trocas feitas.
 */
async function autoSwitchQueued(ctx, connection, domain, limit, now, transaction) {
  const operacoes = safeOperations(domain);
  if (!operacoes.length) return [];
  const itens = await sequelize.query(
    `SELECT d.id FROM "integration"."dispatches" d WHERE d.company_id = :companyId AND d.connection_id = :connectionId AND d.status IN (:statuses) AND d.operation IN (:operacoes) ${alternateSqlFilter(domain)}
      ORDER BY d.created_at ASC, d.id ASC LIMIT :limit`,
    { replacements: { companyId: ctx.companyId, connectionId: connection.id, statuses: QUEUED_STATUSES, operacoes, limit }, type: QueryTypes.SELECT, transaction },
  );
  const feitas = [];
  for (const { id } of itens) {
    try {
      const r = await sequelize.transaction({ transaction }, (sp) => switchToAlternate(ctx, id, { auto: true, now }, sp));
      if (r.switched) feitas.push(r);
      else if (r.reason === 'SEM_ALTERNATIVO_NA_POLITICA' || r.reason === 'CIRCUITO_NAO_FECHADO' || r.reason === 'NAO_ATIVO') break;
    } catch (err) {
      logger.warn({ dispatchId: id, err: err.message, code: err.code }, 'Contingência: não foi possível trocar o envio para o alternativo; ele segue na fila.');
    }
  }
  return feitas;
}

module.exports = { autoSwitchQueued, safeOperations };
