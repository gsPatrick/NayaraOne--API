'use strict';

const { DataTypes } = require('sequelize');

/**
 * CaseRequirement — tabela "correspondent"."case_requirements" (Marco 8 Fase 2). Item do
 * checklist de documentos exigidos por um financing_case (ex: RG_CPF, COMPROVANTE_RENDA).
 */
module.exports = (sequelize) => {
  const CaseRequirement = sequelize.define(
    'CaseRequirement',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      financingCaseId: { type: DataTypes.UUID, allowNull: false, field: 'financing_case_id' },
      documentType: { type: DataTypes.STRING(40), allowNull: false, field: 'document_type' },
      required: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'PENDING' },
      notes: { type: DataTypes.TEXT, allowNull: true },
      applicantId: { type: DataTypes.UUID, allowNull: true, field: 'applicant_id' },
      dismissedBy: { type: DataTypes.UUID, allowNull: true, field: 'dismissed_by' },
      dismissedAt: { type: DataTypes.DATE, allowNull: true, field: 'dismissed_at' },
      dismissReason: { type: DataTypes.TEXT, allowNull: true, field: 'dismiss_reason' },
      createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
      updatedBy: { type: DataTypes.UUID, allowNull: true, field: 'updated_by' },
    },
    {
      schema: 'correspondent',
      tableName: 'case_requirements',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      underscored: true,
    }
  );
  return CaseRequirement;
};
