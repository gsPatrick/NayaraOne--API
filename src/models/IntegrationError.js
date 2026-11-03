'use strict';

const { DataTypes } = require('sequelize');

/**
 * IntegrationError — "correspondent"."integration_errors" (caderno do Marco 8).
 * Guarda o código e uma mensagem de negócio. Não guarda corpo de resposta nem segredo.
 */
module.exports = (sequelize) => {
  const IntegrationError = sequelize.define(
    'IntegrationError',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      financingCaseId: { type: DataTypes.UUID, allowNull: true, field: 'financing_case_id' },
      providerCode: { type: DataTypes.STRING(32), allowNull: false, field: 'provider_code' },
      operation: { type: DataTypes.STRING(40), allowNull: false },
      status: { type: DataTypes.STRING(12), allowNull: false, defaultValue: 'OPEN', field: 'status' },
      resolvedAt: { type: DataTypes.DATE, allowNull: true, field: 'resolved_at' },
      resolvedBy: { type: DataTypes.UUID, allowNull: true, field: 'resolved_by' },
      resolutionNote: { type: DataTypes.TEXT, allowNull: true, field: 'resolution_note' },
      errorCode: { type: DataTypes.STRING(64), allowNull: false, field: 'error_code' },
      message: { type: DataTypes.STRING(500), allowNull: false },
    },
    {
      schema: 'correspondent',
      tableName: 'integration_errors',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      underscored: true,
    }
  );
  return IntegrationError;
};
