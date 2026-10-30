'use strict';

const { DataTypes } = require('sequelize');

/** FileQuarantine — "files"."quarantine" (Marco 9, M9-D247): upload externo em verificação ou o resultado dela. O conteúdo fica no armazenamento, fora do alcance de usuários. */
module.exports = (sequelize) => sequelize.define(
  'FileQuarantine',
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
    groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
    companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
    connectionId: { type: DataTypes.UUID, allowNull: true, field: 'connection_id' },
    externalId: { type: DataTypes.STRING(160), allowNull: true, field: 'external_id' },
    originKey: { type: DataTypes.STRING(400), allowNull: false, field: 'origin_key' },
    fileName: { type: DataTypes.STRING(255), allowNull: true, field: 'file_name' },
    declaredMime: { type: DataTypes.STRING(160), allowNull: true, field: 'declared_mime' },
    detectedMime: { type: DataTypes.STRING(160), allowNull: true, field: 'detected_mime' },
    sizeBytes: { type: DataTypes.BIGINT, allowNull: false, field: 'size_bytes' },
    sha256: { type: DataTypes.STRING(64), allowNull: false },
    cleanSha256: { type: DataTypes.STRING(64), allowNull: true, field: 'clean_sha256' },
    storageKey: { type: DataTypes.STRING(400), allowNull: true, field: 'storage_key' },
    status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'QUARANTINED' },
    reason: { type: DataTypes.STRING(120), allowNull: true },
    signature: { type: DataTypes.STRING(160), allowNull: true },
    metadataStripped: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: 'metadata_stripped' },
    piiDetected: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: 'pii_detected' },
    promotedFileId: { type: DataTypes.UUID, allowNull: true, field: 'promoted_file_id' },
    receivedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW, field: 'received_at' },
    expiresAt: { type: DataTypes.DATE, allowNull: false, field: 'expires_at' },
    verifiedAt: { type: DataTypes.DATE, allowNull: true, field: 'verified_at' },
  },
  { schema: 'files', tableName: 'quarantine', timestamps: true, createdAt: 'created_at', updatedAt: 'updated_at', underscored: true }
);
