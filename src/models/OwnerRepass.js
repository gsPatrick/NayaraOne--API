'use strict';

const { DataTypes } = require('sequelize');

/**
 * OwnerRepass — tabela "finance"."owner_repasses"
 * Repasse de valores líquidos ao proprietário do imóvel após locação/venda.
 */
module.exports = (sequelize) => {
  const OwnerRepass = sequelize.define(
    'OwnerRepass',
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
        allowNull: false,
        field: 'property_id',
      },
      ownerPersonId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'owner_person_id',
      },
      contractId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'contract_id',
      },
      bankAccountId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'bank_account_id',
      },
      grossAmount: {
        type: DataTypes.DECIMAL(18, 2),
        allowNull: false,
        field: 'gross_amount',
      },
      deductionsAmount: {
        type: DataTypes.DECIMAL(18, 2),
        allowNull: false,
        defaultValue: 0,
        field: 'deductions_amount',
      },
      netAmount: {
        type: DataTypes.DECIMAL(18, 2),
        allowNull: false,
        field: 'net_amount',
      },
      referenceMonth: {
        type: DataTypes.STRING(7),
        allowNull: true,
        field: 'reference_month',
        comment: "YYYY-MM",
      },
      status: {
        type: DataTypes.STRING(32),
        allowNull: false,
        defaultValue: 'PENDING',
        field: 'status',
      },
      idempotencyKey: {
        type: DataTypes.STRING(128),
        allowNull: true,
        unique: true,
        field: 'idempotency_key',
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
    },
    {
      schema: 'finance',
      tableName: 'owner_repasses',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      version: 'lockVersion',
      underscored: true,
    }
  );

  return OwnerRepass;
};
