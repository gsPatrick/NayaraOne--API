'use strict';

const { DataTypes } = require('sequelize');

/** InsuranceClaimEvent — tabela "procurement"."insurance_claim_events" (timeline do sinistro). */
module.exports = (sequelize) => {
  const InsuranceClaimEvent = sequelize.define(
    'InsuranceClaimEvent',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      claimId: { type: DataTypes.UUID, allowNull: false, field: 'claim_id' },
      eventType: { type: DataTypes.STRING(32), allowNull: false, field: 'event_type' },
      notes: { type: DataTypes.TEXT, allowNull: true },
      actorUserId: { type: DataTypes.UUID, allowNull: true, field: 'actor_user_id' },
      occurredAt: { type: DataTypes.DATE, allowNull: false, field: 'occurred_at' },
    },
    {
      schema: 'procurement',
      tableName: 'insurance_claim_events',
      timestamps: false,
      underscored: true,
    }
  );

  return InsuranceClaimEvent;
};
