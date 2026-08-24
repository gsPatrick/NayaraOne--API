'use strict';

const { DataTypes } = require('sequelize');

/**
 * KnowledgeEntry — tabela "ai"."knowledge_entries"
 * Fato estruturado e versionado da memória empresarial da NAY (não é cópia integral de conversa).
 */
module.exports = (sequelize) => {
  const KnowledgeEntry = sequelize.define(
    'KnowledgeEntry',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
        allowNull: false,
      },
      groupId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'group_id',
      },
      companyId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'company_id',
      },
      subjectType: {
        type: DataTypes.STRING(64),
        allowNull: false,
        field: 'subject_type',
      },
      subjectId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'subject_id',
      },
      factKey: {
        type: DataTypes.STRING(128),
        allowNull: false,
        field: 'fact_key',
      },
      factValueJson: {
        type: DataTypes.JSONB,
        allowNull: false,
        field: 'fact_value_json',
      },
      origin: {
        type: DataTypes.STRING(64),
        allowNull: true,
        field: 'origin',
      },
      classification: {
        type: DataTypes.STRING(16),
        allowNull: false,
        defaultValue: 'INTERNAL',
        field: 'classification',
      },
      validFrom: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'valid_from',
      },
      validUntil: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'valid_until',
      },
      isActive: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
        field: 'is_active',
      },
      lockVersion: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        field: 'lock_version',
      },
      createdBy: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'created_by',
      },
      updatedBy: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'updated_by',
      },
      deletedBy: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'deleted_by',
      },
    },
    {
      schema: 'ai',
      tableName: 'knowledge_entries',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      paranoid: true,
      deletedAt: 'deleted_at',
      version: 'lockVersion',
      underscored: true,
    }
  );

  return KnowledgeEntry;
};
