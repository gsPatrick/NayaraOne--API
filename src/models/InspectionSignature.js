'use strict';

const { DataTypes } = require('sequelize');

/**
 * InspectionSignature — tabela "legal"."inspection_signatures"
 * Assinatura digital de uma parte (locador/locatário/vistoriador) confirmando o resultado de
 * uma vistoria. Append-only (sem paranoid) — mesmo padrão de imutabilidade de "legal"."signatures".
 */
module.exports = (sequelize) => {
  const InspectionSignature = sequelize.define(
    'InspectionSignature',
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
      inspectionId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'inspection_id',
      },
      partyRole: {
        type: DataTypes.STRING(32),
        allowNull: false,
        field: 'party_role',
        comment: 'LANDLORD|TENANT|INSPECTOR',
      },
      signedByUserId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'signed_by_user_id',
      },
      signatureHash: {
        type: DataTypes.STRING(64),
        allowNull: false,
        field: 'signature_hash',
      },
      signedAt: {
        type: DataTypes.DATE,
        allowNull: false,
        field: 'signed_at',
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
      tableName: 'inspection_signatures',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      underscored: true,
    }
  );

  return InspectionSignature;
};
