'use strict';

const { DataTypes } = require('sequelize');

/**
 * ContractAmendment — tabela "legal"."addenda" (antiga contract_amendments, migration 9986)
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
      // Matriz M5 (Caderno §13): versão base, vigência e cláusulas alteradas.
      baseContractVersionId: { type: DataTypes.UUID, allowNull: true, field: 'base_contract_version_id' },
      effectiveFrom: { type: DataTypes.DATEONLY, allowNull: false, field: 'effective_from' },
      effectiveUntil: { type: DataTypes.DATEONLY, allowNull: true, field: 'effective_until' },
      changedClauses: { type: DataTypes.JSONB, allowNull: false, defaultValue: [], field: 'changed_clauses' },
      status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'DRAFT', field: 'status' },
      createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
    },
    {
      schema: 'legal',
      tableName: 'addenda',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: false,
      underscored: true,
    }
  );

  return ContractAmendment;
};
