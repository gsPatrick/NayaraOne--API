'use strict';

const { DataTypes } = require('sequelize');

/**
 * TaxDocument — tabela "finance"."tax_documents"
 * Documento fiscal emitido/recebido (NFS-e, DIMOB, comprovante de retenção).
 */
module.exports = (sequelize) => {
  const TaxDocument = sequelize.define(
    'TaxDocument',
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
        allowNull: true,
        field: 'contract_id',
      },
      financialEntryId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'financial_entry_id',
      },
      documentType: {
        type: DataTypes.STRING(32),
        allowNull: false,
        field: 'document_type',
        comment: "NFSE|DIMOB|WITHHOLDING_RECEIPT",
      },
      documentNumber: {
        type: DataTypes.STRING(64),
        allowNull: true,
        field: 'document_number',
      },
      issuedAt: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'issued_at',
      },
      amount: {
        type: DataTypes.DECIMAL(18, 2),
        allowNull: true,
        field: 'amount',
      },
      fileId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'file_id',
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
      tableName: 'tax_documents',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      paranoid: true,
      deletedAt: 'deleted_at',
      underscored: true,
    }
  );

  return TaxDocument;
};
