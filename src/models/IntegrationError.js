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
