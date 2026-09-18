'use strict';

const { DataTypes } = require('sequelize');

/**
 * Proposal — tabela "crm"."proposals" (M3-13 / M3-25).
 * Proposta comercial de uma Opportunity, APPEND-ONLY POR VERSÃO: cada rodada de negociação
 * cria uma linha nova com `versionNumber` incrementado; o `value` de uma proposta já enviada
 * nunca é sobrescrito (ver proposals.service.js).
 */
module.exports = (sequelize) => {
  const Proposal = sequelize.define(
    'Proposal',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      opportunityId: { type: DataTypes.UUID, allowNull: false, field: 'opportunity_id' },
      propertyId: { type: DataTypes.UUID, allowNull: true, field: 'property_id' },
      proposedByPersonId: { type: DataTypes.UUID, allowNull: true, field: 'proposed_by_person_id' },
      value: { type: DataTypes.DECIMAL(18, 2), allowNull: false, field: 'value' },
      currency: { type: DataTypes.STRING(3), allowNull: false, defaultValue: 'BRL', field: 'currency' },
      status: {
        type: DataTypes.STRING(24),
        allowNull: false,
        defaultValue: 'DRAFT',
        field: 'status',
        comment: 'DRAFT|SENT|UNDER_NEGOTIATION|ACCEPTED|REJECTED|EXPIRED',
      },
      versionNumber: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1, field: 'version_number' },
      notes: { type: DataTypes.TEXT, allowNull: true, field: 'notes' },
      validUntil: { type: DataTypes.DATE, allowNull: true, field: 'valid_until' },
      sentAt: { type: DataTypes.DATE, allowNull: true, field: 'sent_at' },
      decidedAt: { type: DataTypes.DATE, allowNull: true, field: 'decided_at' },
      decidedByUserId: { type: DataTypes.UUID, allowNull: true, field: 'decided_by_user_id' },
      lockVersion: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'lock_version' },
      createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
      updatedBy: { type: DataTypes.UUID, allowNull: true, field: 'updated_by' },
      deletedBy: { type: DataTypes.UUID, allowNull: true, field: 'deleted_by' },
    },
    {
      schema: 'crm',
      tableName: 'proposals',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      paranoid: true,
      deletedAt: 'deleted_at',
      version: 'lockVersion',
      underscored: true,
    }
  );

  return Proposal;
};
