'use strict';

const { DataTypes } = require('sequelize');

/**
 * IntegrationSyncCursor — "integration"."sync_cursors" (Marco 9, M9-D208).
 * Ponteiro de leitura por (conexão, fluxo), com lease do worker e contagem de falhas.
 */
module.exports = (sequelize) => sequelize.define(
  'IntegrationSyncCursor',
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
    groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
    companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
    connectionId: { type: DataTypes.UUID, allowNull: false, field: 'connection_id' },
    stream: { type: DataTypes.STRING(64), allowNull: false },
    cursorValue: { type: DataTypes.TEXT, allowNull: true, field: 'cursor_value' },
    cursorKind: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'TOKEN', field: 'cursor_kind' },
    highWatermark: { type: DataTypes.DATE, allowNull: true, field: 'high_watermark' },
    status: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'IDLE' },
    leaseOwner: { type: DataTypes.STRING(80), allowNull: true, field: 'lease_owner' },
    leaseExpiresAt: { type: DataTypes.DATE, allowNull: true, field: 'lease_expires_at' },
    lastSuccessAt: { type: DataTypes.DATE, allowNull: true, field: 'last_success_at' },
    lastAttemptAt: { type: DataTypes.DATE, allowNull: true, field: 'last_attempt_at' },
    lastErrorCode: { type: DataTypes.STRING(64), allowNull: true, field: 'last_error_code' },
    consecutiveFailures: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'consecutive_failures' },
    itemsSyncedTotal: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0, field: 'items_synced_total' },
  },
  { schema: 'integration', tableName: 'sync_cursors', timestamps: true, createdAt: 'created_at', updatedAt: 'updated_at', underscored: true }
);
