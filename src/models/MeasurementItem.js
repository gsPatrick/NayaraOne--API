'use strict';

const { DataTypes } = require('sequelize');

/**
 * MeasurementItem — tabela "construction"."measurement_items"
 * Item de uma medição de etapa (M6-11): descrição/quantidade/preço unitário/total.
 */
module.exports = (sequelize) => {
  const MeasurementItem = sequelize.define(
    'MeasurementItem',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
        allowNull: false,
      },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      measurementId: { type: DataTypes.UUID, allowNull: false, field: 'measurement_id' },
      description: { type: DataTypes.STRING(255), allowNull: false, field: 'description' },
      quantity: { type: DataTypes.DECIMAL(18, 4), allowNull: false, field: 'quantity' },
      unitPrice: { type: DataTypes.DECIMAL(18, 2), allowNull: false, field: 'unit_price' },
      total: { type: DataTypes.DECIMAL(18, 2), allowNull: false, field: 'total' },
      createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
      updatedBy: { type: DataTypes.UUID, allowNull: true, field: 'updated_by' },
    },
    {
      schema: 'construction',
      tableName: 'measurement_items',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      underscored: true,
    }
  );

  return MeasurementItem;
};
