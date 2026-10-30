'use strict';

const { DataTypes } = require('sequelize');

/**
 * SitePage — "integration"."site_pages" (Marco 9, M9-D259): a página do site ligada ao envio corrente. `status` é o estado interno (só muda por evento de confirmação) e
 * `siteSyncStatus` o que falta para o site refletir o ERP; a falha do site nunca desfaz o estado interno.
 */
module.exports = (sequelize) => sequelize.define(
  'SitePage',
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
    groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
    companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
    connectionId: { type: DataTypes.UUID, allowNull: false, field: 'connection_id' },
    pageKey: { type: DataTypes.STRING(160), allowNull: false, field: 'page_key' },
    propertyId: { type: DataTypes.UUID, allowNull: true, field: 'property_id' },
    slug: { type: DataTypes.STRING(160), allowNull: false },
    locale: { type: DataTypes.STRING(16), allowNull: false },
    contentHash: { type: DataTypes.STRING(64), allowNull: false, field: 'content_hash' },
    publishedHash: { type: DataTypes.STRING(64), allowNull: true, field: 'published_hash' },
    status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'PENDING' },
    siteSyncStatus: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'PENDING_SYNC', field: 'site_sync_status' },
    publishCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'publish_count' },
    dispatchId: { type: DataTypes.UUID, allowNull: true, field: 'dispatch_id' },
    dispatchOperation: { type: DataTypes.STRING(32), allowNull: true, field: 'dispatch_operation' },
    appliedRank: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: -1, field: 'applied_rank' },
    appliedStatus: { type: DataTypes.STRING(16), allowNull: true, field: 'applied_status' },
    dispatchConfirmed: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: 'dispatch_confirmed' },
    statusChecks: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'status_checks' },
    statusCheckedAt: { type: DataTypes.DATE, allowNull: true, field: 'status_checked_at' },
    publishedAt: { type: DataTypes.DATE, allowNull: true, field: 'published_at' },
    unpublishedAt: { type: DataTypes.DATE, allowNull: true, field: 'unpublished_at' },
    lastError: { type: DataTypes.STRING(300), allowNull: true, field: 'last_error' },
    requestedBy: { type: DataTypes.UUID, allowNull: true, field: 'requested_by' },
  },
  { schema: 'integration', tableName: 'site_pages', timestamps: true, createdAt: 'created_at', updatedAt: 'updated_at', underscored: true }
);
