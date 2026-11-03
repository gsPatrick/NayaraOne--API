'use strict';

const { DataTypes } = require('sequelize');

/**
 * FiscalObligation — tabela "correspondent"."fiscal_obligations" (Marco 8 Fase 12). Cobre também
 * o "calendário fiscal" do Caderno: due_at + status já É a agenda, não há tabela separada
 * "fiscal_calendar" (seria dado derivado duplicado da mesma informação).
 */
module.exports = (sequelize) => {
  const FiscalObligation = sequelize.define(
    'FiscalObligation',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      obligationType: { type: DataTypes.STRING(32), allowNull: false, field: 'obligation_type' },
      referenceYear: { type: DataTypes.INTEGER, allowNull: false, field: 'reference_year' },
      dueAt: { type: DataTypes.DATEONLY, allowNull: false, field: 'due_at' },
      status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'PENDING' },
      description: { type: DataTypes.TEXT, allowNull: false, field: 'description' },
      dimobBatchId: { type: DataTypes.UUID, allowNull: true, field: 'dimob_batch_id' },
      completedAt: { type: DataTypes.DATE, allowNull: true, field: 'completed_at' },
    },
    {
      schema: 'correspondent',
      tableName: 'fiscal_obligations',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      underscored: true,
    }
  );
  return FiscalObligation;
};
