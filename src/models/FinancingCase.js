'use strict';

const { DataTypes } = require('sequelize');

/**
 * FinancingCase — tabela "correspondent"."financing_cases" (Marco 8, Caderno "CORRESPONDENTE
 * BANCÁRIO + NC + FINANCIAMENTOS"). Um registro por operação de financiamento. `status` aqui só
 * alcança DRAFT nesta fase (Fase 1) — a máquina de estados completa é Fase 6.
 */
module.exports = (sequelize) => {
  const FinancingCase = sequelize.define(
    'FinancingCase',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      propertyId: { type: DataTypes.UUID, allowNull: true, field: 'property_id' },
      providerCode: { type: DataTypes.STRING(32), allowNull: false, defaultValue: 'sandbox', field: 'provider_code' },
      purpose: { type: DataTypes.STRING(24), allowNull: false, defaultValue: 'RESIDENCIAL', field: 'purpose' },
      status: { type: DataTypes.STRING(24), allowNull: false, defaultValue: 'DRAFT', field: 'status' },
      lockVersion: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'lock_version' },
      createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
      updatedBy: { type: DataTypes.UUID, allowNull: true, field: 'updated_by' },
    },
    {
      schema: 'correspondent',
      tableName: 'financing_cases',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      version: 'lockVersion',
      underscored: true,
    }
  );
  return FinancingCase;
};
