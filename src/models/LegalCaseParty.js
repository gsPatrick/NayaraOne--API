'use strict';

const { DataTypes } = require('sequelize');

/**
 * LegalCaseParty — tabela "legal"."legal_case_parties"
 * Parte formal de um processo jurídico (PLAINTIFF|DEFENDANT|WITNESS|THIRD_PARTY).
 */
module.exports = (sequelize) => {
  const LegalCaseParty = sequelize.define(
    'LegalCaseParty',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      legalCaseId: { type: DataTypes.UUID, allowNull: false, field: 'legal_case_id' },
      personId: { type: DataTypes.UUID, allowNull: false, field: 'person_id' },
      partyRole: { type: DataTypes.STRING(32), allowNull: false, field: 'party_role' },
      createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
      updatedBy: { type: DataTypes.UUID, allowNull: true, field: 'updated_by' },
    },
    {
      schema: 'legal',
      tableName: 'legal_case_parties',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      underscored: true,
    }
  );

  return LegalCaseParty;
};
