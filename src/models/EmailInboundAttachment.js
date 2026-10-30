'use strict';

const { DataTypes } = require('sequelize');

/** EmailInboundAttachment — "integration"."email_inbound_attachments" (Marco 9, M9-D235): anexo recebido, ligado à quarentena e, quando limpo, ao arquivo promovido. */
module.exports = (sequelize) => sequelize.define(
  'EmailInboundAttachment',
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
    groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
    companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
    messageId: { type: DataTypes.UUID, allowNull: false, field: 'message_id' },
    position: { type: DataTypes.INTEGER, allowNull: false },
    fileName: { type: DataTypes.STRING(255), allowNull: true, field: 'file_name' },
    declaredMime: { type: DataTypes.STRING(160), allowNull: true, field: 'declared_mime' },
    sizeBytes: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0, field: 'size_bytes' },
    sha256: { type: DataTypes.STRING(64), allowNull: true },
    quarantineId: { type: DataTypes.UUID, allowNull: true, field: 'quarantine_id' },
    status: { type: DataTypes.STRING(12), allowNull: false, defaultValue: 'QUARANTINED' },
    blockCode: { type: DataTypes.STRING(80), allowNull: true, field: 'block_code' },
    fileId: { type: DataTypes.UUID, allowNull: true, field: 'file_id' },
  },
  { schema: 'integration', tableName: 'email_inbound_attachments', timestamps: true, createdAt: 'created_at', updatedAt: 'updated_at', underscored: true }
);
