'use strict';

const { DataTypes } = require('sequelize');

/**
 * ProviderStatusHistory — tabela "correspondent"."provider_status_history" (Marco 8 Fase 6).
 * Append-only: nunca é atualizada, só inserida. Guarda SEMPRE o status bruto do provider e o
 * normalizado (quando reconhecido), mesmo quando a transição é ignorada por estar fora de ordem
 * (`applied: false`) — nunca se perde o evento bruto.
 */
module.exports = (sequelize) => {
  const ProviderStatusHistory = sequelize.define(
    'ProviderStatusHistory',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      financingCaseId: { type: DataTypes.UUID, allowNull: false, field: 'financing_case_id' },
      rawProviderStatus: { type: DataTypes.STRING(64), allowNull: false, field: 'raw_provider_status' },
      normalizedStatus: { type: DataTypes.STRING(32), allowNull: true, field: 'normalized_status' },
      source: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'webhook' },
      applied: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      occurredAt: { type: DataTypes.DATE, allowNull: false, field: 'occurred_at' },
    },
    {
      schema: 'correspondent',
      tableName: 'provider_status_history',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: false,
      underscored: true,
    }
  );
  return ProviderStatusHistory;
};
