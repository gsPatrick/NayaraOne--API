'use strict';

const { DataTypes } = require('sequelize');

/**
 * PortalListing — tabela "real_estate"."portal_listings" (M9-D232): o anúncio de um imóvel num portal. Estados: PENDING_SYNC, PUBLISHING, PUBLISHED, REJECTED,
 * UNPUBLISHING, UNPUBLISHED, ERROR. Um anúncio ativo por (imóvel, portal): `superseded_at` nulo.
 */
module.exports = (sequelize) => sequelize.define(
  'PortalListing',
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
    groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
    companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
    propertyId: { type: DataTypes.UUID, allowNull: false, field: 'property_id' },
    connectionId: { type: DataTypes.UUID, allowNull: false, field: 'connection_id' },
    externalListingId: { type: DataTypes.STRING(160), allowNull: true, field: 'external_listing_id' },
    status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'PENDING_SYNC' },
    mappingVersion: { type: DataTypes.STRING(16), allowNull: false, field: 'mapping_version' },
    payloadHash: { type: DataTypes.CHAR(64), allowNull: true, field: 'payload_hash' },
    fieldsDropped: { type: DataTypes.JSONB, allowNull: false, defaultValue: [], field: 'fields_dropped' },
    rejectionReason: { type: DataTypes.STRING(200), allowNull: true, field: 'rejection_reason' },
    lastSyncedAt: { type: DataTypes.DATE, allowNull: true, field: 'last_synced_at' },
    lastError: { type: DataTypes.TEXT, allowNull: true, field: 'last_error' },
    supersededAt: { type: DataTypes.DATE, allowNull: true, field: 'superseded_at' },
    // M9-D233: controle da despublicação (pedido, reenvios, próxima conferência do job e esgotamento).
    unpublishRequestedAt: { type: DataTypes.DATE, allowNull: true, field: 'unpublish_requested_at' },
    unpublishAttempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'unpublish_attempts' },
    unpublishNextAttemptAt: { type: DataTypes.DATE, allowNull: true, field: 'unpublish_next_attempt_at' },
    unpublishExhaustedAt: { type: DataTypes.DATE, allowNull: true, field: 'unpublish_exhausted_at' },
  },
  { schema: 'real_estate', tableName: 'portal_listings', timestamps: true, createdAt: 'created_at', updatedAt: 'updated_at', underscored: true },
);
