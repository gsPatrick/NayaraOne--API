'use strict';

const { DataTypes } = require('sequelize');

/**
 * InventoryAdjustmentProposal — tabela "inventory"."adjustment_proposals" (migration
 * 20260101000582). Revisão Marco 7 (19/10/2026), A6/EST-008: ajuste/descarte manual de estoque
 * é proposta PENDING aprovada por OUTRA pessoa com inventory:approve.
 */
module.exports = (sequelize) =>
  sequelize.define(
    'InventoryAdjustmentProposal',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      inventoryItemId: { type: DataTypes.UUID, allowNull: false, field: 'inventory_item_id' },
      movementType: { type: DataTypes.STRING(16), allowNull: false, field: 'movement_type' },
      quantity: { type: DataTypes.DECIMAL(18, 4), allowNull: false, field: 'quantity' },
      sourceLocationId: { type: DataTypes.UUID, allowNull: true, field: 'source_location_id' },
      destinationLocationId: { type: DataTypes.UUID, allowNull: true, field: 'destination_location_id' },
      projectId: { type: DataTypes.UUID, allowNull: true, field: 'project_id' },
      stageId: { type: DataTypes.UUID, allowNull: true, field: 'stage_id' },
      reason: { type: DataTypes.STRING(500), allowNull: false, field: 'reason' },
      evidenceFileId: { type: DataTypes.UUID, allowNull: true, field: 'evidence_file_id' },
      estimatedValue: { type: DataTypes.DECIMAL(18, 2), allowNull: true, field: 'estimated_value' },
      idempotencyKey: { type: DataTypes.STRING(255), allowNull: false, field: 'idempotency_key' },
      status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'PENDING', field: 'status' },
      proposedByUserId: { type: DataTypes.UUID, allowNull: false, field: 'proposed_by_user_id' },
      decidedByUserId: { type: DataTypes.UUID, allowNull: true, field: 'decided_by_user_id' },
      decidedAt: { type: DataTypes.DATE, allowNull: true, field: 'decided_at' },
      decisionNote: { type: DataTypes.STRING(500), allowNull: true, field: 'decision_note' },
      resultingMovementId: { type: DataTypes.UUID, allowNull: true, field: 'resulting_movement_id' },
    },
    { schema: 'inventory', tableName: 'adjustment_proposals', timestamps: true, createdAt: 'created_at', updatedAt: 'updated_at', underscored: true }
  );
