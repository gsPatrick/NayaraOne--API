'use strict';

/**
 * M9-D617 — apoio dos read models de Locação: parâmetros do administrador como replacements, o recorte "contratos de locação" e a data-base.
 * Contrato de locação = tipo em analytics.locacao.tipos_contrato (padrão: LEASE_LIKE_TYPES do jurídico), não excluído.
 */
const { sequelize } = require('../../../../models');
const { businessDateKey } = require('../../../../utils/businessDate');
const { readLocacaoParams } = require('../locacao.settings');
const { readOverdueWindowDays } = require('../financeHealth.settings');

/** Contratos de locação da empresa (subconsulta; usa :companyId e :leaseTypes). */
const LEASE_IDS = `(SELECT lc.id FROM legal.contracts lc WHERE lc.company_id = :companyId AND lc.deleted_at IS NULL AND lc.contract_type IN (:leaseTypes))`;

async function params(scope, transaction) {
  const p = await readLocacaoParams(scope, transaction);
  return { ...p, windowDays: await readOverdueWindowDays(scope, transaction), openStatuses: ['ACTIVE', 'SUSPENDED'], worksStatuses: ['ACTIVE', 'PAUSED', 'FINAL_INSPECTION'] };
}

/** Chave dos read models de retrato do dia: a data-base é a do relógio do worker. */
const todayKey = (_event, { now }) => ({ as_of_date: businessDateKey(now) });

async function oneRow(sql, replacements, transaction) {
  const [rows] = await sequelize.query(sql, { replacements, transaction });
  return rows[0] || null;
}

module.exports = { LEASE_IDS, params, todayKey, oneRow };
