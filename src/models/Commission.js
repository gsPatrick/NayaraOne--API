'use strict';

const { DataTypes } = require('sequelize');

/**
 * Commission — tabela "finance"."commissions"
 * Comissão calculada para um corretor/colaborador sobre uma oportunidade/contrato fechado.
 */
module.exports = (sequelize) => {
  const Commission = sequelize.define(
    'Commission',
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
      opportunityId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'opportunity_id',
      },
      contractId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'contract_id',
      },
      beneficiaryUserId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'beneficiary_user_id',
      },
      baseAmount: {
        type: DataTypes.DECIMAL(18, 2),
        allowNull: false,
        field: 'base_amount',
      },
      percentage: {
        type: DataTypes.DECIMAL(9, 6),
        allowNull: false,
        field: 'percentage',
      },
      totalAmount: {
        type: DataTypes.DECIMAL(18, 2),
        allowNull: false,
        field: 'total_amount',
      },
      ruleVersionId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'rule_version_id',
        comment: "Rastreabilidade: versão da regra que gerou o valor (core.rule_versions)",
      },
      status: {
        type: DataTypes.STRING(32),
        allowNull: false,
        defaultValue: 'PENDING',
        field: 'status',
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
      schema: 'finance',
      tableName: 'commissions',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      paranoid: true,
      deletedAt: 'deleted_at',
      version: 'lockVersion',
      underscored: true,
    }
  );

  return Commission;
};
