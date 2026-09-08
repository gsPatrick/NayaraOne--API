'use strict';

const { DataTypes } = require('sequelize');

/**
 * UtilityObligation — tabela "finance"."utility_obligations". Obrigação recorrente de
 * utilidade (água/energia/gás/condomínio/IPTU/SPU/outro) vinculada a um contrato de locação.
 */
module.exports = (sequelize) => {
  const UtilityObligation = sequelize.define(
    'UtilityObligation',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      contractId: { type: DataTypes.UUID, allowNull: false, field: 'contract_id' },
      utilityType: { type: DataTypes.STRING(32), allowNull: false, field: 'utility_type' },
      responsibleParty: { type: DataTypes.STRING(16), allowNull: false, field: 'responsible_party' },
      provider: { type: DataTypes.STRING(120), allowNull: true, field: 'provider' },
      accountNumber: { type: DataTypes.STRING(60), allowNull: true, field: 'account_number' },
      transferRequired: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: 'transfer_required' },
      evidenceFileId: { type: DataTypes.UUID, allowNull: true, field: 'evidence_file_id' },
      status: { type: DataTypes.STRING(32), allowNull: false, defaultValue: 'ACTIVE', field: 'status' },
      lockVersion: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'lock_version' },
      createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
      updatedBy: { type: DataTypes.UUID, allowNull: true, field: 'updated_by' },
      deletedBy: { type: DataTypes.UUID, allowNull: true, field: 'deleted_by' },
    },
    {
      schema: 'finance',
      tableName: 'utility_obligations',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      paranoid: true,
      deletedAt: 'deleted_at',
      version: 'lockVersion',
      underscored: true,
    }
  );

  return UtilityObligation;
};
