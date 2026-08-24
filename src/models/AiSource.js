'use strict';

const { DataTypes } = require('sequelize');

/**
 * AiSource — tabela "ai"."ai_sources"
 * Fonte documental/interna citada por uma resposta da NAY (rastreabilidade antialucinação).
 */
module.exports = (sequelize) => {
  const AiSource = sequelize.define(
    'AiSource',
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
      aiRunId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'ai_run_id',
      },
      sourceType: {
        type: DataTypes.STRING(64),
        allowNull: false,
        field: 'source_type',
        comment: "ex. DB_RECORD|DOCUMENT|KNOWLEDGE_ENTRY",
      },
      sourceRef: {
        type: DataTypes.STRING(255),
        allowNull: true,
        field: 'source_ref',
      },
      excerpt: {
        type: DataTypes.TEXT,
        allowNull: true,
        field: 'excerpt',
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
    },
    {
      schema: 'ai',
      tableName: 'ai_sources',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      underscored: true,
    }
  );

  return AiSource;
};
