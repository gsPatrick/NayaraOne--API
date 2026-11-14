'use strict';

const { DataTypes } = require('sequelize');

/**
 * TemplateVersion — tabela "legal"."template_versions" (Caderno M5 §4/§6, migration 9982): versão numerada do
 * modelo. DRAFT recebe vínculos de cláusula; PUBLISHED é imutável (gatilho) e só vira SUPERSEDED.
 */
module.exports = (sequelize) => sequelize.define(
  'TemplateVersion',
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
    groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
    companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
    templateId: { type: DataTypes.UUID, allowNull: false, field: 'template_id' },
    versionNumber: { type: DataTypes.INTEGER, allowNull: false, field: 'version_number' },
    status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'DRAFT', field: 'status' },
    legalResponsibleUserId: { type: DataTypes.UUID, allowNull: true, field: 'legal_responsible_user_id' },
    publishedBy: { type: DataTypes.UUID, allowNull: true, field: 'published_by' },
    publishedAt: { type: DataTypes.DATE, allowNull: true, field: 'published_at' },
    createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
    // USER (padrão) ou CODE_SEED: versão inicial com texto que vigorava no código, sem aprovador humano (migration 20260101015103).
    origin: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'USER', field: 'origin' },
  },
  { schema: 'legal', tableName: 'template_versions', timestamps: true, createdAt: 'created_at', updatedAt: 'updated_at', underscored: true }
);
