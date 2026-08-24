'use strict';

const { DataTypes } = require('sequelize');

/**
 * ContractParty — tabela "legal"."contract_parties"
 * Parte envolvida em um contrato (locador, locatário, fiador, comprador, vendedor).
 */
module.exports = (sequelize) => {
  const ContractParty = sequelize.define(
    'ContractParty',
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
      personId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'person_id',
      },
      partyRole: {
        type: DataTypes.STRING(32),
        allowNull: false,
        field: 'party_role',
        comment: "LANDLORD|TENANT|GUARANTOR|BUYER|SELLER",
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
      schema: 'legal',
      tableName: 'contract_parties',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      paranoid: true,
      deletedAt: 'deleted_at',
      underscored: true,
    }
  );

  return ContractParty;
};
