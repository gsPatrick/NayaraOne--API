'use strict';

const { DataTypes } = require('sequelize');

/**
 * ContractNumberSequence — tabela "legal"."contract_number_sequences"
 * Contador atômico de numeração de contratos, por (company_id, contract_type, year).
 * Usado exclusivamente via upsert atômico em contracts.service.js#generateContractNumber —
 * nunca lido/escrito por SELECT+INSERT manual (ver comentário na migration 20260101000177).
 */
module.exports = (sequelize) => {
  const ContractNumberSequence = sequelize.define(
    'ContractNumberSequence',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
        allowNull: false,
      },
      companyId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'company_id',
      },
      contractType: {
        type: DataTypes.STRING(32),
        allowNull: false,
        field: 'contract_type',
      },
      year: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },
      lastSeq: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        field: 'last_seq',
      },
    },
    {
      schema: 'legal',
      tableName: 'contract_number_sequences',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      underscored: true,
    }
  );

  return ContractNumberSequence;
};
