'use strict';

const { DataTypes } = require('sequelize');

/**
 * PersonDocument — tabela "people"."person_documents" (TAB-0103)
 * Documento formal vinculado a uma pessoa (RG, CIN, CNH, IR, HOLERITE etc.).
 * UNIQUE(person_id, document_type, version_no).
 */
module.exports = (sequelize) => {
  const PersonDocument = sequelize.define(
    'PersonDocument',
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
      personId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'person_id',
      },
      documentType: {
        type: DataTypes.STRING(64),
        allowNull: false,
        field: 'document_type',
        comment: 'RG|CIN|CNH|IR|HOLERITE etc. (lista aberta)',
      },
      fileId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'file_id',
      },
      versionNo: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 1,
        field: 'version_no',
      },
      issuedAt: {
        type: DataTypes.DATEONLY,
        allowNull: true,
        field: 'issued_at',
      },
      expiresAt: {
        type: DataTypes.DATEONLY,
        allowNull: true,
        field: 'expires_at',
      },
      verificationStatus: {
        type: DataTypes.STRING(30),
        allowNull: false,
        defaultValue: 'PENDING',
        field: 'verification_status',
        comment: 'PENDING|VERIFIED|REJECTED',
      },
      verifiedBy: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'verified_by',
      },
      extractedDataJson: {
        type: DataTypes.JSONB,
        allowNull: true,
        field: 'extracted_data_json',
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
      schema: 'people',
      tableName: 'person_documents',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      paranoid: true,
      deletedAt: 'deleted_at',
      underscored: true,
    }
  );

  return PersonDocument;
};
