'use strict';

const { DataTypes } = require('sequelize');

/**
 * ContractVersion — tabela "legal"."contract_versions"
 * Versão imutável de um contrato (aditivos geram nova versão, nunca edição da anterior).
 */
module.exports = (sequelize) => {
  const ContractVersion = sequelize.define(
    'ContractVersion',
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
        allowNull: false,
        field: 'contract_id',
      },
      versionNumber: {
        type: DataTypes.INTEGER,
        allowNull: false,
        field: 'version_number',
      },
      documentFileId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'document_file_id',
      },
      contentHash: {
        type: DataTypes.STRING(64),
        allowNull: true,
        field: 'content_hash',
      },
      effectiveFrom: {
        type: DataTypes.DATE,
        allowNull: false,
        field: 'effective_from',
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
      schema: 'legal',
      tableName: 'contract_versions',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      underscored: true,
    }
  );

  return ContractVersion;
};
