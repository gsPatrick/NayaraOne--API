'use strict';

const { DataTypes } = require('sequelize');

/**
 * Signature — tabela "legal"."signatures"
 * Assinatura eletrônica de uma parte sobre uma versão de contrato.
 */
module.exports = (sequelize) => {
  const Signature = sequelize.define(
    'Signature',
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
      contractVersionId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'contract_version_id',
      },
      personId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'person_id',
      },
      signedAt: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'signed_at',
      },
      status: {
        type: DataTypes.STRING(32),
        allowNull: false,
        defaultValue: 'PENDING',
        field: 'status',
      },
      externalSignatureId: {
        type: DataTypes.STRING(128),
        allowNull: true,
        field: 'external_signature_id',
        comment: "ID no provedor de assinatura eletrônica",
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
      tableName: 'signatures',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      underscored: true,
    }
  );

  return Signature;
};
