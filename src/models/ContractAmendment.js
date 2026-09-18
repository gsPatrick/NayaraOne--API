'use strict';

const { DataTypes } = require('sequelize');

/**
 * ContractAmendment — tabela "legal"."contract_amendments"
 * Aditivo contratual numerado sequencialmente por contrato. Append-only: sem updated_at e sem
 * soft delete; o único campo mutável é `status` (DRAFT -> SIGNED).
 */
module.exports = (sequelize) => {
  const ContractAmendment = sequelize.define(
    'ContractAmendment',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      contractId: { type: DataTypes.UUID, allowNull: false, field: 'contract_id' },
      amendmentNumber: { type: DataTypes.INTEGER, allowNull: false, field: 'amendment_number' },
      reason: { type: DataTypes.TEXT, allowNull: false, field: 'reason' },
      changesJson: { type: DataTypes.JSONB, allowNull: false, field: 'changes_json' },
      documentFileId: { type: DataTypes.UUID, allowNull: true, field: 'document_file_id' },
      status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'DRAFT', field: 'status' },
      createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
    },
    {
      schema: 'legal',
      tableName: 'contract_amendments',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: false,
      underscored: true,
    }
  );

  return ContractAmendment;
};
