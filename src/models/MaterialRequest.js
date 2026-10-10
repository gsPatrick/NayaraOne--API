'use strict';

const { DataTypes } = require('sequelize');

/**
 * MaterialRequest — tabela "construction"."material_requests"
 * Requisição mínima de material nascida da obra/etapa (M6-28). DECISÃO DE ENGENHARIA: este é
 * o mínimo esperado para o Marco 6 — a integração completa com Estoque/Patrimônio (movimento
 * real de saldo, devolução com movimento inverso, alçada de perda) é escopo do Marco 7. Aqui
 * apenas registramos a requisição e o recebimento, com eventos de domínio para o consumidor
 * de Estoque integrar quando esse módulo existir.
 */
module.exports = (sequelize) => {
  const MaterialRequest = sequelize.define(
    'MaterialRequest',
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
      projectId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'project_id',
      },
      stageId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'stage_id',
      },
      description: {
        type: DataTypes.STRING(255),
        allowNull: false,
      },
      quantity: {
        type: DataTypes.DECIMAL(18, 3),
        allowNull: false,
      },
      unit: {
        type: DataTypes.STRING(16),
        allowNull: false,
      },
      status: {
        type: DataTypes.STRING(32),
        allowNull: false,
        defaultValue: 'REQUESTED',
        comment: 'REQUESTED|RECEIVED',
      },
      requestedByUserId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'requested_by_user_id',
      },
      receivedAt: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'received_at',
      },
      lockVersion: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        field: 'lock_version',
      },
      // Item 3 (fechamento de gaps pós-Marco 6) — mesmo padrão de captura offline já usado em
      // DailyReport (M6-94): o app de campo gera a chave localmente e a envia ao sincronizar;
      // reenviar a MESMA chave não cria uma segunda requisição. UNIQUE parcial via migration
      // 20260101000295 (só quando não-nulo).
      idempotencyKey: {
        type: DataTypes.STRING(128),
        allowNull: true,
        field: 'idempotency_key',
      },
      createdBy: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'created_by',
      },
      updatedBy: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'updated_by',
      },
      deletedBy: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'deleted_by',
      },
    },
    {
      schema: 'construction',
      tableName: 'material_requests',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      paranoid: true,
      deletedAt: 'deleted_at',
      version: 'lockVersion',
      underscored: true,
    }
  );

  return MaterialRequest;
};
