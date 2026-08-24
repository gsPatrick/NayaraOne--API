'use strict';

const { DataTypes } = require('sequelize');

/**
 * InsuranceCase — tabela "legal"."insurance_cases"
 * Sinistro/caso de seguro vinculado a um imóvel ou contrato.
 */
module.exports = (sequelize) => {
  const InsuranceCase = sequelize.define(
    'InsuranceCase',
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
      propertyId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'property_id',
      },
      contractId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'contract_id',
      },
      policyNumber: {
        type: DataTypes.STRING(64),
        allowNull: true,
        field: 'policy_number',
      },
      caseType: {
        type: DataTypes.STRING(32),
        allowNull: true,
        field: 'case_type',
      },
      status: {
        type: DataTypes.STRING(32),
        allowNull: false,
        defaultValue: 'OPEN',
        field: 'status',
      },
      claimAmount: {
        type: DataTypes.DECIMAL(18, 2),
        allowNull: true,
        field: 'claim_amount',
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
      tableName: 'insurance_cases',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      paranoid: true,
      deletedAt: 'deleted_at',
      version: 'lockVersion',
      underscored: true,
    }
  );

  return InsuranceCase;
};
