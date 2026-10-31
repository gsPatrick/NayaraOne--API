'use strict';

const { DataTypes } = require('sequelize');

/**
 * FiscalReconciliation — tabela "correspondent"."fiscal_reconciliations" (Marco 8 Fase 12).
 * Financeiro × NFS-e, serviços/comissões × fiscal, DIMOB × contratos/transações — qualquer
 * diferença encontrada abre este registro, NUNCA é ignorada silenciosamente (citação literal do
 * Caderno).
 */
module.exports = (sequelize) => {
  const FiscalReconciliation = sequelize.define(
    'FiscalReconciliation',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      reconciliationType: { type: DataTypes.STRING(32), allowNull: false, field: 'reconciliation_type' },
      referenceId: { type: DataTypes.UUID, allowNull: false, field: 'reference_id' },
      expectedAmount: { type: DataTypes.DECIMAL(14, 2), allowNull: false, field: 'expected_amount' },
      actualAmount: { type: DataTypes.DECIMAL(14, 2), allowNull: false, field: 'actual_amount' },
      differenceAmount: { type: DataTypes.DECIMAL(14, 2), allowNull: false, field: 'difference_amount' },
      status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'OPEN' },
      detectedAt: { type: DataTypes.DATE, allowNull: false, field: 'detected_at' },
      resolutionNote: { type: DataTypes.TEXT, allowNull: true, field: 'resolution_note' },
      resolutionKind: { type: DataTypes.STRING(16), allowNull: true, field: 'resolution_kind' },
      acceptedDifference: { type: DataTypes.DECIMAL(14, 2), allowNull: true, field: 'accepted_difference' },
      resolvedAt: { type: DataTypes.DATE, allowNull: true, field: 'resolved_at' },
    },
    {
      schema: 'correspondent',
      tableName: 'fiscal_reconciliations',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      underscored: true,
    }
  );
  return FiscalReconciliation;
};
