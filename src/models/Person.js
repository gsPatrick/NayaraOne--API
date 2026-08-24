'use strict';

const { DataTypes } = require('sequelize');

/**
 * Person — tabela "people"."persons" (TAB-0100)
 * Pessoa física ou jurídica cadastrada (cliente, proprietário, fornecedor, colaborador etc.).
 */
module.exports = (sequelize) => {
  const Person = sequelize.define(
    'Person',
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
      personType: {
        type: DataTypes.STRING(10),
        allowNull: false,
        defaultValue: 'PF',
        field: 'person_type',
        comment: 'PF|PJ',
      },
      legalName: {
        type: DataTypes.STRING(200),
        allowNull: false,
        field: 'legal_name',
        comment: 'Nome ou razão social',
      },
      preferredName: {
        type: DataTypes.STRING(150),
        allowNull: true,
        field: 'preferred_name',
        comment: 'Nome de uso/fantasia',
      },
      taxIdNormalized: {
        type: DataTypes.STRING(20),
        allowNull: true,
        field: 'tax_id_normalized',
        comment: 'CPF/CNPJ normalizado — PII, mascarado na camada de aplicação',
      },
      taxIdNormalizedHash: {
        type: DataTypes.STRING(128),
        allowNull: true,
        field: 'tax_id_normalized_hash',
        comment: 'HMAC do tax_id, para busca exata sem expor valor em claro',
      },
      birthOrFoundationDate: {
        type: DataTypes.DATEONLY,
        allowNull: true,
        field: 'birth_or_foundation_date',
      },
      status: {
        type: DataTypes.STRING(30),
        allowNull: false,
        defaultValue: 'ACTIVE',
        field: 'status',
        comment: 'ACTIVE|INACTIVE|BLOCKED|MERGED',
      },
      mergedIntoId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'merged_into_id',
      },
      riskFlagsJson: {
        type: DataTypes.JSONB,
        allowNull: true,
        field: 'risk_flags_json',
      },
      lockVersion: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        field: 'lock_version',
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
      tableName: 'persons',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      paranoid: true,
      deletedAt: 'deleted_at',
      version: 'lockVersion',
      underscored: true,
    }
  );

  return Person;
};
