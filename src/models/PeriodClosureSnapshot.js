'use strict';

const { DataTypes } = require('sequelize');

/**
 * PeriodClosureSnapshot — tabela "finance"."period_closure_snapshots" (F02, Caderno §16 / Guia
 * §12 "calculate closing snapshot"). Retrato imutável do mês no momento do CLOSED; o banco
 * recusa UPDATE/DELETE (trigger trg_period_closure_snapshots_append_only).
 */
module.exports = (sequelize) => {
  const PeriodClosureSnapshot = sequelize.define(
    'PeriodClosureSnapshot',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      periodClosureId: { type: DataTypes.UUID, allowNull: false, field: 'period_closure_id' },
      referenceMonth: { type: DataTypes.STRING(7), allowNull: false, field: 'reference_month' },
      snapshotJson: { type: DataTypes.JSONB, allowNull: false, field: 'snapshot_json' },
      snapshotHash: { type: DataTypes.STRING(64), allowNull: false, field: 'snapshot_hash' },
      createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
    },
    {
      schema: 'finance',
      tableName: 'period_closure_snapshots',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: false,
      underscored: true,
    }
  );

  return PeriodClosureSnapshot;
};
