'use strict';

const { DataTypes } = require('sequelize');

/**
 * LegalCase — tabela "legal"."legal_cases"
 * Processo/caso jurídico (contencioso ou consultivo) vinculado a contrato/imóvel/pessoa.
 */
module.exports = (sequelize) => {
  const LegalCase = sequelize.define(
    'LegalCase',
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
      contractId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'contract_id',
      },
      propertyId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'property_id',
      },
      responsibleUserId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'responsible_user_id',
      },
      caseNumber: {
        type: DataTypes.STRING(64),
        allowNull: true,
        field: 'case_number',
      },
      caseType: {
        type: DataTypes.STRING(32),
        allowNull: false,
        field: 'case_type',
        comment: "LITIGATION|CONSULTATIVE|COLLECTION",
      },
      status: {
        type: DataTypes.STRING(32),
        allowNull: false,
        defaultValue: 'OPEN',
        field: 'status',
      },
      summary: {
        type: DataTypes.TEXT,
        allowNull: true,
        field: 'summary',
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
      schema: 'legal',
      tableName: 'legal_cases',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      paranoid: true,
      deletedAt: 'deleted_at',
      version: 'lockVersion',
      underscored: true,
    }
  );

  return LegalCase;
};
