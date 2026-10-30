'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize, Property } = require('../../../../models');

/**
 * Destino PROPERTY (imóvel do ERP antigo). Campos canônicos: internalCode, title, propertyType (RESIDENTIAL|COMMERCIAL|LAND|RURAL), addressLine, city, state, zipCode,
 * areaTotalM2, bedrooms, parkingSpots, description. Código interno já usado por outro imóvel do grupo = possível duplicata (PENDING_REVIEW).
 */
const TYPES = ['RESIDENTIAL', 'COMMERCIAL', 'LAND', 'RURAL'];

async function assess(tenant, row, existingTargetId, transaction) {
  const code = typeof row.internalCode === 'string' ? row.internalCode.trim() : '';
  if (!code || code.length > 64) return { state: 'QUARANTINED', reason: 'Código interno do imóvel ausente ou longo demais.' };
  if (!row.title || String(row.title).length > 255) return { state: 'QUARANTINED', reason: 'Título do imóvel ausente ou longo demais.' };
  if (!TYPES.includes(row.propertyType || 'RESIDENTIAL')) return { state: 'QUARANTINED', reason: 'Tipo de imóvel inválido.' };
  if (row.areaTotalM2 !== undefined && row.areaTotalM2 !== null && !(Number(row.areaTotalM2) >= 0)) return { state: 'QUARANTINED', reason: 'Área inválida.' };
  const [dup] = await sequelize.query(
    'SELECT id FROM real_estate.properties WHERE group_id = :groupId AND internal_code = :code AND (:self::uuid IS NULL OR id <> :self::uuid) LIMIT 1',
    { type: QueryTypes.SELECT, transaction, replacements: { groupId: tenant.groupId, code, self: existingTargetId || null } }
  );
  return dup ? { state: 'PENDING_REVIEW', reason: `Possível duplicata: o código interno já pertence ao imóvel ${dup.id}.` } : null;
}

const fieldsOf = (row) => ({
  internalCode: row.internalCode.trim(), title: row.title, propertyType: row.propertyType || 'RESIDENTIAL', addressLine: row.addressLine || null, city: row.city || null,
  state: row.state || null, zipCode: row.zipCode || null, areaTotalM2: row.areaTotalM2 === undefined ? null : row.areaTotalM2, bedrooms: row.bedrooms === undefined ? null : row.bedrooms,
  parkingSpots: row.parkingSpots === undefined ? null : row.parkingSpots, description: row.description || null,
});

async function upsert(tenant, actor, row, existingTargetId, transaction) {
  const fields = fieldsOf(row);
  if (existingTargetId) {
    await Property.update({ ...fields, updatedBy: actor.userId || null }, { where: { id: existingTargetId, companyId: tenant.companyId }, transaction });
    await sequelize.query('UPDATE real_estate.properties SET source_deleted = false, source_deleted_at = NULL WHERE id = :id AND source_deleted', { transaction, replacements: { id: existingTargetId } });
    return existingTargetId;
  }
  const created = await Property.create({ groupId: tenant.groupId, companyId: tenant.companyId, ...fields, createdBy: actor.userId || null, updatedBy: actor.userId || null }, { transaction });
  return created.id;
}

function markDeleted(tenant, targetId, transaction) {
  return sequelize.query('UPDATE real_estate.properties SET source_deleted = true, source_deleted_at = COALESCE(source_deleted_at, now()) WHERE company_id = :companyId AND id = :id', { transaction, replacements: { companyId: tenant.companyId, id: targetId } });
}

module.exports = { entityType: 'PROPERTY', assess, upsert, markDeleted };
