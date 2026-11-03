'use strict';

const { DataTypes } = require('sequelize');

/** InsurancePolicyParty — tabela "procurement"."insurance_policy_parties". */
module.exports = (sequelize) => {
  const InsurancePolicyParty = sequelize.define(
    'InsurancePolicyParty',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      policyId: { type: DataTypes.UUID, allowNull: false, field: 'policy_id' },
      partyRole: { type: DataTypes.STRING(24), allowNull: false, field: 'party_role' },
      personId: { type: DataTypes.UUID, allowNull: true, field: 'person_id' },
    },
    {
      schema: 'procurement',
      tableName: 'insurance_policy_parties',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: false,
      underscored: true,
    }
  );

  return InsurancePolicyParty;
};
