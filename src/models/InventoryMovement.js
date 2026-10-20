'use strict';

const { DataTypes } = require('sequelize');

/**
 * InventoryMovement — tabela "inventory"."inventory_movements"
 * Movimentação append-only de entrada/saída de um item de estoque.
 */
module.exports = (sequelize) => {
  const InventoryMovement = sequelize.define(
    'InventoryMovement',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
        allowNull: false,
      },
      groupId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'group_id',
      },
      companyId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'company_id',
      },
      inventoryItemId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'inventory_item_id',
      },
      projectId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'project_id',
      },
      // BUG REAL CORRIGIDO (reauditoria externa Nayara, 2026-10-08; EST-004: "Material consumido
      // precisa de project_id/stage_id quando atribuído à obra"): stageId era validado na
      // requisição mas nunca gravado no ledger real — propagado agora pelos chamadores
      // (requisitions.service.js/counts.service.js/lossCases.service.js).
      stageId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'stage_id',
      },
      movementType: {
        type: DataTypes.STRING(16),
        allowNull: false,
        field: 'movement_type',
        comment: "IN|OUT|RETURN|TRANSFER|ADJUSTMENT|LOSS|DISPOSAL",
      },
      // BUG REAL CORRIGIDO (rodada 47): TAB-0751 exige numeric(18,4) — DECIMAL(9,6) dava
      // overflow em movimentos acima de ~999 unidades.
      quantity: {
        type: DataTypes.DECIMAL(18, 4),
        allowNull: false,
        field: 'quantity',
      },
      sourceLocationId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'source_location_id',
      },
      destinationLocationId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'destination_location_id',
      },
      sourceType: {
        type: DataTypes.STRING(32),
        allowNull: true,
        field: 'source_type',
        comment: 'RECEIPT|REQUISITION|TOOL_LOAN|ADJUSTMENT|COUNT|LOSS_CASE|MANUAL',
      },
      sourceId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'source_id',
      },
      idempotencyKey: {
        type: DataTypes.STRING(255),
        allowNull: true,
        field: 'idempotency_key',
      },
      responsiblePersonId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'responsible_person_id',
      },
      evidenceFileId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'evidence_file_id',
      },
      reason: {
        type: DataTypes.STRING(500),
        allowNull: true,
        field: 'reason',
        comment: 'EST-008: motivo obrigatório para ADJUSTMENT/LOSS/DISPOSAL.',
      },
      // Revisão Marco 7 (19/10/2026), A1/EST-011: custo HISTÓRICO gravado no fato (migration
      // 20260101000580). A obra soma estes valores — nunca o custo médio de hoje.
      unitCost: {
        type: DataTypes.DECIMAL(18, 6),
        allowNull: true,
        field: 'unit_cost',
      },
      totalCost: {
        type: DataTypes.DECIMAL(18, 2),
        allowNull: true,
        field: 'total_cost',
      },
      costSource: {
        type: DataTypes.STRING(32),
        allowNull: true,
        field: 'cost_source',
        comment: 'RECORDED|BACKFILL_RECEIPT|BACKFILL_CURRENT_AVERAGE|UNKNOWN',
      },
      movedAt: {
        type: DataTypes.DATE,
        allowNull: false,
        field: 'moved_at',
      },
      movedByUserId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'moved_by_user_id',
      },
      // BUG REAL CORRIGIDO (rodada 47): TAB-0751 trata created_by como NOT NULL — ledger
      // imutável de estoque sem autor quebra rastreabilidade. Validação fail-closed em
      // movements.service.js#recordMovement garante que nunca chega null aqui.
      createdBy: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'created_by',
      },
      updatedBy: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'updated_by',
      },
    },
    {
      schema: 'inventory',
      tableName: 'inventory_movements',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      underscored: true,
    }
  );

  return InventoryMovement;
};
