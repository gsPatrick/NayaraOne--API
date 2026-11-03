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
      // Marco 8 Fase 12 (migration 351) — vincula a NFS-e emitida ao pedido de emissão do
      // Correspondente Bancário. Nullable: os outros documentType (DIMOB, WITHHOLDING_RECEIPT)
      // não têm InvoiceRequest de origem.
      invoiceRequestId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'invoice_request_id',
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
      // Marco 8 (migration 634) — XML/PDF/ID oficial da NFS-e preservados com hash de integridade.
      xmlContent: { type: DataTypes.TEXT, allowNull: true, field: 'xml_content' },
      xmlSha256: { type: DataTypes.STRING(64), allowNull: true, field: 'xml_sha256' },
      pdfContent: { type: DataTypes.BLOB, allowNull: true, field: 'pdf_content' },
      pdfSha256: { type: DataTypes.STRING(64), allowNull: true, field: 'pdf_sha256' },
      verificationCode: { type: DataTypes.STRING(64), allowNull: true, field: 'verification_code' },
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
