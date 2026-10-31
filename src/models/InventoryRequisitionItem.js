'use strict';

const { DataTypes } = require('sequelize');

/**
 * InventoryRequisitionItem — tabela "inventory"."requisition_items"
 * Linha de item solicitado dentro de uma InventoryRequisition; issuedQuantity acompanha
 * baixa parcial (uma requisição pode ser entregue em mais de uma retirada).
 */
module.exports = (sequelize) => {
  const InventoryRequisitionItem = sequelize.define(
    'InventoryRequisitionItem',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      requisitionId: { type: DataTypes.UUID, allowNull: false, field: 'requisition_id' },
      inventoryItemId: { type: DataTypes.UUID, allowNull: false, field: 'inventory_item_id' },
      quantity: { type: DataTypes.DECIMAL(14, 6), allowNull: false, field: 'quantity' },
      issuedQuantity: { type: DataTypes.DECIMAL(14, 6), allowNull: false, defaultValue: 0, field: 'issued_quantity' },
    },
    {
      schema: 'inventory',
      tableName: 'requisition_items',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      underscored: true,
    }
  );

  return InventoryRequisitionItem;
};
