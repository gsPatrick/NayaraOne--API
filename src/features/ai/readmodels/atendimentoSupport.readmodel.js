'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');
const { PUBLIC_FIELDS } = require('../../properties/publicReadModel/constants');

/** Subconjunto dos campos públicos que a conversa precisa (sem fotos, descrição longa nem coordenadas). */
const LISTING_COLUMNS = Object.freeze(['public_code', 'title', 'purpose', 'type', 'price_public', 'neighborhood', 'city', 'state', 'bedrooms', 'bathrooms', 'parking_spots', 'area_total']);
if (!LISTING_COLUMNS.every((c) => PUBLIC_FIELDS.includes(c))) throw new Error('Coluna fora da lista de campos públicos.');

/**
 * Consultas de apoio à NAY Atendimento (M9-D041). Único lugar do agente que fala SQL (archGuard AI-004), sempre na transação do tenant
 * (RLS FORCE continua valendo).
 */

/** Responsável pelo encaminhamento: o membro ativo mais antigo da empresa com o papel indicado (nome do papel sem caixa), ou null. */
async function findHandoffResponsible(companyId, roleName, transaction) {
  if (typeof roleName !== 'string' || !roleName.trim()) return null;
  const rows = await sequelize.query(
    `SELECT m.user_id FROM core.user_memberships m JOIN core.roles r ON r.id = m.role_id
      WHERE m.company_id = :companyId AND m.status = 'ACTIVE' AND m.deleted_at IS NULL AND lower(r.name) = lower(:roleName)
      ORDER BY m.created_at ASC, m.user_id ASC LIMIT 1`,
    { replacements: { companyId, roleName: roleName.trim() }, transaction, type: QueryTypes.SELECT }
  );
  return rows.length ? rows[0].user_id : null;
}

/** Anúncios públicos da empresa: só os campos públicos do read model do M9-D231 (nada além do que o site e os portais já mostram). */
async function listPublicListings(companyId, limit, transaction) {
  return sequelize.query(
    `SELECT ${LISTING_COLUMNS.join(', ')} FROM "real_estate"."public_property_read_model" WHERE company_id = :companyId ORDER BY published_at DESC NULLS LAST, public_code ASC LIMIT :limit`,
    { replacements: { companyId, limit }, transaction, type: QueryTypes.SELECT }
  );
}

module.exports = { findHandoffResponsible, listPublicListings, LISTING_COLUMNS };
