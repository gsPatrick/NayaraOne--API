'use strict';

/**
 * M9-D616 — apoio dos read models de Comercial/CRM e Imóveis: constantes de domínio, parâmetros do administrador como replacements e a
 * busca do agregado afetado pelo evento (uma linha da fonte pelo id do payload, sempre da empresa do evento).
 */
const { sequelize } = require('../../../../models');
const { readComercialParams } = require('../comercial.settings');

/** Sem corretor atribuído: UUID zero na chave (nunca NULL na chave única), como o "sem setor" do Financeiro (DI-D616-1). */
const NO_BROKER = '00000000-0000-0000-0000-000000000000';
/** Estágios terminais (CLOSED_LIKE_STAGES de crm/dashboard.service.js): não entram nas contagens de "em andamento". */
const CLOSED_STAGES = Object.freeze(['CLOSED_WON', 'CLOSED_LOST', 'WITHDRAWN']);
const brokerExpr = (col) => `COALESCE(${col}, CAST('${NO_BROKER}' AS uuid))`;

async function params(scope, transaction) {
  const p = await readComercialParams(scope, transaction);
  return { stalledDays: p.stalledDays, recalcDays: p.recalcDays, includeNay: p.includeNay, bands: p.bands, closedStages: CLOSED_STAGES, noBroker: NO_BROKER };
}

/** Primeira linha de uma consulta de leitura (ou null). */
async function oneRow(sql, replacements, transaction) {
  const [rows] = await sequelize.query(sql, { replacements, transaction });
  return rows[0] || null;
}

/** Id da oportunidade no payload: nos eventos da oportunidade é `id`; no evento de interação é `opportunityId`. */
function opportunityIdOf(event) {
  const p = event.payloadJson || event.payload || {};
  return String(event.eventType).startsWith('crm.opportunity.') ? p.id : p.opportunityId;
}

module.exports = { NO_BROKER, CLOSED_STAGES, brokerExpr, params, oneRow, opportunityIdOf };
