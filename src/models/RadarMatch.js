'use strict';

const { DataTypes } = require('sequelize');

/**
 * RadarMatch — tabela "crm"."radar_matches" (Marco 3 §13 / Guia §9): match gravado do Radar com score, critérios atendidos e
 * falhos, explicação, impressão digital dos critérios e versão da pontuação. Histórico imutável (só INSERT; gatilho no banco
 * recusa UPDATE/DELETE). Gravado por src/features/radar/radarMatchStore.service.js.
 */
module.exports = (sequelize) => {
  const RadarMatch = sequelize.define(
    'RadarMatch',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      radarId: { type: DataTypes.UUID, allowNull: false, field: 'radar_id' },
      propertyId: { type: DataTypes.UUID, allowNull: false, field: 'property_id' },
      score: { type: DataTypes.DECIMAL(5, 4), allowNull: false, field: 'score' },
      matchedCriteria: { type: DataTypes.JSONB, allowNull: false, field: 'matched_criteria' },
      failedCriteria: { type: DataTypes.JSONB, allowNull: false, field: 'failed_criteria' },
      explanation: { type: DataTypes.JSONB, allowNull: false, field: 'explanation' },
      criteriaFingerprint: { type: DataTypes.STRING(64), allowNull: false, field: 'criteria_fingerprint' },
      criteriaVersion: { type: DataTypes.STRING(32), allowNull: false, field: 'criteria_version' },
    },
    { schema: 'crm', tableName: 'radar_matches', timestamps: true, createdAt: 'created_at', updatedAt: false, underscored: true }
  );
  return RadarMatch;
};
