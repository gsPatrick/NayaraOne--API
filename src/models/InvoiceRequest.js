'use strict';

const { DataTypes } = require('sequelize');

/**
 * InvoiceRequest — tabela "correspondent"."invoice_requests" (Marco 8 Fase 12, addendum fiscal).
 * Ciclo REQUESTED→SUBMITTED→AUTHORIZED/REJECTED/CANCELED (NFS-e), citação literal do Caderno.
 * `sourceType`/`sourceId` referenciam genericamente a origem (ex: uma comissão confirmada que
 * gerou a nota) — nunca copia dado da origem, só referencia.
 */
module.exports = (sequelize) => {
  const InvoiceRequest = sequelize.define(
    'InvoiceRequest',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      sourceType: { type: DataTypes.STRING(32), allowNull: false, field: 'source_type' },
      sourceId: { type: DataTypes.UUID, allowNull: false, field: 'source_id' },
      status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'REQUESTED' },
      adapterVersion: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'sandbox-v1', field: 'adapter_version' },
      externalId: { type: DataTypes.STRING(128), allowNull: true, field: 'external_id' },
      amount: { type: DataTypes.DECIMAL(14, 2), allowNull: false },
      description: { type: DataTypes.TEXT, allowNull: false },
      rejectionReason: { type: DataTypes.TEXT, allowNull: true, field: 'rejection_reason' },
      attemptNumber: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'attempt_number' },
      createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
      updatedBy: { type: DataTypes.UUID, allowNull: true, field: 'updated_by' },
    },
    {
      schema: 'correspondent',
      tableName: 'invoice_requests',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      underscored: true,
    }
  );
  return InvoiceRequest;
};
