'use strict';

const { DataTypes } = require('sequelize');

/**
 * AnomalyCase — tabela "finance"."anomaly_cases"
 * Caso de anomalia/antifraude com ciclo de vida próprio (OPEN/RESOLVED) — Caderno §5/§17/§19.
 * `caseType` identifica a origem (ex.: "AMOUNT_OUTLIER", "FREQUENT_REVERSAL"); `relatedEntityType`/
 * `relatedEntityId` apontam pro registro que disparou o caso (FinancialEntry na maioria dos casos).
 */
module.exports = (sequelize) => {
  const AnomalyCase = sequelize.define(
    'AnomalyCase',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
        allowNull: false,
      },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      caseType: { type: DataTypes.STRING(40), allowNull: false, field: 'case_type' },
      riskLevel: {
        type: DataTypes.STRING(16),
        allowNull: false,
        field: 'risk_level',
        comment: 'LOW|MEDIUM|HIGH|CRITICAL',
      },
      relatedEntityType: { type: DataTypes.STRING(60), allowNull: true, field: 'related_entity_type' },
      relatedEntityId: { type: DataTypes.UUID, allowNull: true, field: 'related_entity_id' },
      reason: { type: DataTypes.TEXT, allowNull: false, field: 'reason' },
      status: {
        type: DataTypes.STRING(16),
        allowNull: false,
        defaultValue: 'OPEN',
        field: 'status',
        comment: 'OPEN|RESOLVED',
      },
      resolvedAt: { type: DataTypes.DATE, allowNull: true, field: 'resolved_at' },
      resolvedBy: { type: DataTypes.UUID, allowNull: true, field: 'resolved_by' },
      resolutionNote: { type: DataTypes.TEXT, allowNull: true, field: 'resolution_note' },
      createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
      updatedBy: { type: DataTypes.UUID, allowNull: true, field: 'updated_by' },
    },
    {
      schema: 'finance',
      tableName: 'anomaly_cases',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      underscored: true,
    }
  );

  return AnomalyCase;
};
