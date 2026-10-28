'use strict';

const { DataTypes } = require('sequelize');

/**
 * IntegrationError — "integration"."integration_errors" (Marco 9, M9-D207): falhas operacionais de qualquer integração.
 * A tabela antiga correspondent.integration_errors virou legado somente leitura; o Correspondente grava aqui com
 * `source = 'DISPATCH'` e guarda o id do caso em `source_ref_id` (atributo `financingCaseId`, nome que o Correspondente
 * já usa). O payload é sempre sanitizado (errors/sanitizeForError.js); nunca há corpo bruto nem segredo.
 */
module.exports = (sequelize) => {
  const IntegrationError = sequelize.define(
    'IntegrationError',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      connectionId: { type: DataTypes.UUID, allowNull: true, field: 'connection_id' },
      providerCode: { type: DataTypes.STRING(48), allowNull: false, field: 'provider_code' },
      source: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'DISPATCH' },
      financingCaseId: { type: DataTypes.UUID, allowNull: true, field: 'source_ref_id' },
      operation: { type: DataTypes.STRING(40), allowNull: true },
      errorClass: { type: DataTypes.STRING(12), allowNull: false, defaultValue: 'UNKNOWN', field: 'error_class' },
      errorCode: { type: DataTypes.STRING(64), allowNull: false, field: 'error_code' },
      severity: { type: DataTypes.STRING(8), allowNull: false, defaultValue: 'MEDIUM' },
      message: { type: DataTypes.STRING(500), allowNull: false },
      sanitizedPayload: { type: DataTypes.JSONB, allowNull: true, field: 'sanitized_payload' },
      payloadHash: { type: DataTypes.CHAR(64), allowNull: true, field: 'payload_hash' },
      httpStatus: { type: DataTypes.INTEGER, allowNull: true, field: 'http_status' },
      attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
      status: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'OPEN' },
      resolvedBy: { type: DataTypes.UUID, allowNull: true, field: 'resolved_by' },
      resolvedAt: { type: DataTypes.DATE, allowNull: true, field: 'resolved_at' },
      resolutionNote: { type: DataTypes.STRING(500), allowNull: true, field: 'resolution_note' },
      correlationId: { type: DataTypes.STRING(64), allowNull: true, field: 'correlation_id' },
    },
    {
      schema: 'integration',
      tableName: 'integration_errors',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: false,
      underscored: true,
    }
  );
  return IntegrationError;
};
