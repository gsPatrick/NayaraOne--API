'use strict';

const { DataTypes } = require('sequelize');

/**
 * InventoryToolLoan — tabela "inventory"."tool_loans"
 * Empréstimo/saída de ferramenta (Asset): OPEN -> RETURNED (ou OVERDUE enquanto aberto após due_at).
 */
module.exports = (sequelize) => {
  const InventoryToolLoan = sequelize.define(
    'InventoryToolLoan',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      assetId: { type: DataTypes.UUID, allowNull: false, field: 'asset_id' },
      personUserId: { type: DataTypes.UUID, allowNull: false, field: 'person_user_id' },
      destinationLocationId: { type: DataTypes.UUID, allowNull: true, field: 'destination_location_id' },
      sourceLocationId: { type: DataTypes.UUID, allowNull: true, field: 'source_location_id' },
      dueAt: { type: DataTypes.DATE, allowNull: true, field: 'due_at' },
      returnedAt: { type: DataTypes.DATE, allowNull: true, field: 'returned_at' },
      conditionCode: { type: DataTypes.STRING(16), allowNull: true, field: 'condition_code' },
      status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'OPEN', field: 'status' },
      lockVersion: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'lock_version' },
      createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
      updatedBy: { type: DataTypes.UUID, allowNull: true, field: 'updated_by' },
    },
    {
      schema: 'inventory',
      tableName: 'tool_loans',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      version: 'lockVersion',
      underscored: true,
    }
  );

  return InventoryToolLoan;
};
