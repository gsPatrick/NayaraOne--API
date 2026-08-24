'use strict';

const { DataTypes } = require('sequelize');

/**
 * Contract — tabela "legal"."contracts"
 * Contrato (venda, locação, prestação de serviço) — cabeçalho.
 */
module.exports = (sequelize) => {
  const Contract = sequelize.define(
    'Contract',
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
      opportunityId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'opportunity_id',
      },
      contractType: {
        type: DataTypes.STRING(32),
        allowNull: false,
        field: 'contract_type',
        comment: "SALE|LEASE|SERVICE",
      },
      contractNumber: {
        type: DataTypes.STRING(64),
        allowNull: true,
        field: 'contract_number',
      },
      status: {
        type: DataTypes.STRING(32),
        allowNull: false,
        defaultValue: 'DRAFT',
        field: 'status',
      },
      totalValue: {
        type: DataTypes.DECIMAL(18, 2),
        allowNull: true,
        field: 'total_value',
      },
      startsAt: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'starts_at',
      },
      endsAt: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'ends_at',
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
      tableName: 'contracts',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      paranoid: true,
      deletedAt: 'deleted_at',
      version: 'lockVersion',
      underscored: true,
    }
  );

  return Contract;
};
