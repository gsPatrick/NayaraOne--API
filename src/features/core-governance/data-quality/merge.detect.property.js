'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');
const { REASONS } = require('./merge.constants');
const { normText, digits, alnum, liveProperty } = require('./merge.detect.sql');

/**
 * Imóvel: mesma matrícula ou mesmo endereço com unidade (score alto); mesmo logradouro, número e CEP com área parecida (score menor).
 * Endereço vem de property_addresses (ou das colunas do próprio imóvel quando não há endereço ligado). Duas unidades diferentes do mesmo
 * prédio (complementos preenchidos e diferentes) nunca casam pela regra de área.
 */
async function detectPropertyPairs(tenant, config, transaction) {
  const rows = await sequelize.query(
    `WITH p AS (
       SELECT x.id, ${alnum('x.registry_number')} AS registry, ${normText('coalesce(pa.street, x.address_line)')} AS street, ${normText('pa.number')} AS num,
              ${digits('coalesce(pa.zip_code, x.zip_code)')} AS zip, ${normText('pa.complement')} AS unit, x.area_total_m2::numeric AS area
         FROM real_estate.properties x LEFT JOIN real_estate.property_addresses pa ON pa.id = x.address_id WHERE ${liveProperty('x')})
     SELECT a.id AS a_id, b.id AS b_id, true AS by_registry, false AS by_unit, false AS by_area
       FROM p a JOIN p b ON a.registry = b.registry AND a.id < b.id WHERE a.registry <> ''
     UNION ALL
     SELECT a.id, b.id, false, (a.unit <> '' AND a.unit = b.unit),
            (NOT (a.unit <> '' AND b.unit <> '' AND a.unit <> b.unit) AND a.area > 0 AND b.area > 0 AND abs(a.area - b.area) / greatest(a.area, b.area) * 100 < :areaPct)
       FROM p a JOIN p b ON a.street = b.street AND a.num = b.num AND a.zip = b.zip AND a.id < b.id WHERE a.street <> '' AND a.zip <> ''`,
    { type: QueryTypes.SELECT, transaction, replacements: { companyId: tenant.companyId, areaPct: config.areaPct } }
  );
  const pick = (row, flag, reason) => (row[flag] ? { primaryId: row.a_id, secondaryId: row.b_id, reason, score: config.scores[reason] } : null);
  return rows.flatMap((row) => [
    pick(row, 'by_registry', REASONS.PROPERTY_REGISTRY), pick(row, 'by_unit', REASONS.PROPERTY_ADDRESS_UNIT), pick(row, 'by_area', REASONS.PROPERTY_ADDRESS_AREA),
  ].filter(Boolean));
}

module.exports = { detectPropertyPairs };
