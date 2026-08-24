'use strict';

const { DataTypes } = require('sequelize');

/**
 * EvidencePackage — tabela "legal"."evidence_packages"
 * Pacote de evidências (manifest) imutável anexado a um processo jurídico.
 * Append-only por design — ver decisão de engenharia na migration
 * 20260101000091-create-legal-evidence_packages.js: sem updated_at/updated_by/soft delete.
 */
module.exports = (sequelize) => {
  const EvidencePackage = sequelize.define(
    'EvidencePackage',
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
      legalCaseId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'legal_case_id',
      },
      manifestJson: {
        type: DataTypes.JSONB,
        allowNull: false,
        field: 'manifest_json',
      },
      packageHash: {
        type: DataTypes.STRING(64),
        allowNull: false,
        field: 'package_hash',
      },
      createdBy: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'created_by',
      },
    },
    {
      schema: 'legal',
      tableName: 'evidence_packages',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: false,
      underscored: true,
    }
  );

  return EvidencePackage;
};
