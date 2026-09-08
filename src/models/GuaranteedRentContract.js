'use strict';

const { DataTypes } = require('sequelize');

/**
 * GuaranteedRentContract — tabela "finance"."guaranteed_rent_contracts". Aluguel garantido:
 * produto SEPARADO de RentAdvance (antecipação) — nunca compartilha tabela/fluxo com ela.
 */
module.exports = (sequelize) => {
  const GuaranteedRentContract = sequelize.define(
    'GuaranteedRentContract',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      contractId: { type: DataTypes.UUID, allowNull: false, field: 'contract_id' },
      status: { type: DataTypes.STRING(32), allowNull: false, defaultValue: 'ACTIVE', field: 'status' },
      coverageStartsAt: { type: DataTypes.DATEONLY, allowNull: false, field: 'coverage_starts_at' },
      coverageEndsAt: { type: DataTypes.DATEONLY, allowNull: true, field: 'coverage_ends_at' },
      paymentsJson: { type: DataTypes.JSONB, allowNull: false, defaultValue: [], field: 'payments_json' },
      lockVersion: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'lock_version' },
      createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
      updatedBy: { type: DataTypes.UUID, allowNull: true, field: 'updated_by' },
      deletedBy: { type: DataTypes.UUID, allowNull: true, field: 'deleted_by' },
    },
    {
      schema: 'finance',
      tableName: 'guaranteed_rent_contracts',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      paranoid: true,
      deletedAt: 'deleted_at',
      version: 'lockVersion',
      underscored: true,
    }
  );

  return GuaranteedRentContract;
};
