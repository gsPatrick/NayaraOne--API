'use strict';

const { DataTypes } = require('sequelize');
const dataClassification = require('../shared/data-classification/scale');

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
      // M9-D910: o banco guarda a escala nova (LOW..RESTRICTED); o módulo de IA ainda lê e escreve PUBLIC/INTERNAL/CONFIDENTIAL/RESTRICTED, então o modelo traduz nos dois sentidos.
      classification: {
        type: DataTypes.STRING(16),
        allowNull: false,
        defaultValue: 'MEDIUM',
        field: 'classification',
        ...dataClassification.attributeOptions({ legacyView: true }),
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
      version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1, field: 'version', comment: 'inteiro por fact_key (M9-D008)' },
      status: { type: DataTypes.STRING(12), allowNull: false, defaultValue: 'DRAFT', field: 'status', comment: 'DRAFT|HOMOLOGATED|REVOKED|SUPERSEDED' },
      homologatedBy: { type: DataTypes.UUID, allowNull: true, field: 'homologated_by' },
      homologatedAt: { type: DataTypes.DATE, allowNull: true, field: 'homologated_at' },
      revokedBy: { type: DataTypes.UUID, allowNull: true, field: 'revoked_by' },
      revokedAt: { type: DataTypes.DATE, allowNull: true, field: 'revoked_at' },
      revokeReason: { type: DataTypes.TEXT, allowNull: true, field: 'revoke_reason' },
      contentHash: { type: DataTypes.STRING(64), allowNull: false, field: 'content_hash' },
      ownerUserId: { type: DataTypes.UUID, allowNull: true, field: 'owner_user_id' },
      sourceId: { type: DataTypes.UUID, allowNull: true, field: 'source_id', comment: 'registro de origem do conhecimento (sem FK)' },
      title: { type: DataTypes.STRING(200), allowNull: false, field: 'title' },
      bodyStructured: { type: DataTypes.JSONB, allowNull: true, field: 'body_structured' },
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
