'use strict';

const { DataTypes } = require('sequelize');

/**
 * Appraisal — tabela "correspondent"."appraisals" (Marco 8 Fase 7). Registro de avaliação do
 * imóvel solicitada a um provider via `adapter.requestAppraisal()`. Puramente informativo —
 * nenhum código deste módulo escreve `requestedValue` de volta em `properties`/`property_offers`
 * (invariante do Caderno, testado em test/correspondent.appraisals.test.js).
 */
module.exports = (sequelize) => {
  const Appraisal = sequelize.define(
    'Appraisal',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      financingCaseId: { type: DataTypes.UUID, allowNull: false, field: 'financing_case_id' },
      providerCode: { type: DataTypes.STRING(32), allowNull: false, field: 'provider_code' },
      externalId: { type: DataTypes.STRING(128), allowNull: true, field: 'external_id' },
      status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'REQUESTED' },
      requestedValue: { type: DataTypes.DECIMAL(14, 2), allowNull: true, field: 'requested_value' },
      requestSnapshot: { type: DataTypes.JSONB, allowNull: false, field: 'request_snapshot' },
      responseSnapshot: { type: DataTypes.JSONB, allowNull: true, field: 'response_snapshot' },
      createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
    },
    {
      schema: 'correspondent',
      tableName: 'appraisals',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      underscored: true,
    }
  );
  return Appraisal;
};
