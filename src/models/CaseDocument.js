'use strict';

const { DataTypes } = require('sequelize');

/**
 * CaseDocument — tabela "correspondent"."case_documents" (Marco 8 Fase 2). Versão de um
 * arquivo enviado pra um case_requirement. Nunca é UPDATE: uma nova versão sempre é uma nova
 * linha, com a anterior marcada em `supersededAt` (preserva histórico, índice único parcial no
 * banco garante no máximo uma versão vigente por requirement).
 */
module.exports = (sequelize) => {
  const CaseDocument = sequelize.define(
    'CaseDocument',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      financingCaseId: { type: DataTypes.UUID, allowNull: false, field: 'financing_case_id' },
      requirementId: { type: DataTypes.UUID, allowNull: false, field: 'requirement_id' },
      fileId: { type: DataTypes.UUID, allowNull: false, field: 'file_id' },
      version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
      classification: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'RESTRICTED' },
      supersededAt: { type: DataTypes.DATE, allowNull: true, field: 'superseded_at' },
      uploadedBy: { type: DataTypes.UUID, allowNull: true, field: 'uploaded_by' },
    },
    {
      schema: 'correspondent',
      tableName: 'case_documents',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: false,
      underscored: true,
    }
  );
  return CaseDocument;
};
