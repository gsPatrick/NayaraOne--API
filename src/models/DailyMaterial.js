'use strict';

const { DataTypes } = require('sequelize');

/**
 * DailyMaterial — tabela "construction"."daily_materials"
 * Materiais usados no dia de um RDO (descrição livre — ver DECISÃO DE ENGENHARIA na migration
 * 20260101000194, integração formal com Estoque fica para o Marco 7).
 */
module.exports = (sequelize) => {
  const DailyMaterial = sequelize.define(
    'DailyMaterial',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
        allowNull: false,
      },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      dailyReportId: { type: DataTypes.UUID, allowNull: false, field: 'daily_report_id' },
      materialDescription: { type: DataTypes.STRING(255), allowNull: false, field: 'material_description' },
      quantity: { type: DataTypes.DECIMAL(14, 4), allowNull: false, field: 'quantity' },
      unit: { type: DataTypes.STRING(16), allowNull: false, field: 'unit' },
      createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
      updatedBy: { type: DataTypes.UUID, allowNull: true, field: 'updated_by' },
      deletedBy: { type: DataTypes.UUID, allowNull: true, field: 'deleted_by' },
    },
    {
      schema: 'construction',
      tableName: 'daily_materials',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      paranoid: true,
      deletedAt: 'deleted_at',
      underscored: true,
    }
  );

  return DailyMaterial;
};
