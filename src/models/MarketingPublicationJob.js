'use strict';

const { DataTypes } = require('sequelize');

/**
 * MarketingPublicationJob — tabela "marketing"."publication_jobs".
 * Job de publicação (M9-D401): um por conteúdo, canal e horário; a idempotency_key evita duplicar.
 */
module.exports = (sequelize) => {
  const MarketingPublicationJob = sequelize.define(
    'MarketingPublicationJob',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      contentVersionId: { type: DataTypes.UUID, allowNull: false, field: 'content_version_id' },
      channel: { type: DataTypes.STRING(16), allowNull: false, field: 'channel' },
      adapterCode: { type: DataTypes.STRING(80), allowNull: false, field: 'adapter_code' },
      connectionId: { type: DataTypes.UUID, allowNull: true, field: 'connection_id' },
      status: { type: DataTypes.STRING(12), allowNull: false, defaultValue: 'PENDING', field: 'status' },
      idempotencyKey: { type: DataTypes.STRING(300), allowNull: false, field: 'idempotency_key' },
      scheduledAt: { type: DataTypes.DATE, allowNull: false, field: 'scheduled_at' },
      attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'attempts' },
      nextAttemptAt: { type: DataTypes.DATE, allowNull: true, field: 'next_attempt_at' },
      externalPostId: { type: DataTypes.STRING(300), allowNull: true, field: 'external_post_id' },
      lastErrorCode: { type: DataTypes.STRING(120), allowNull: true, field: 'last_error_code' },
      createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
      updatedBy: { type: DataTypes.UUID, allowNull: true, field: 'updated_by' },
    },
    {
      schema: 'marketing',
      tableName: 'publication_jobs',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      paranoid: true,
      deletedAt: 'deleted_at',
      underscored: true,
    }
  );

  return MarketingPublicationJob;
};
