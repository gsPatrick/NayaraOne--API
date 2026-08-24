'use strict';

const { DataTypes } = require('sequelize');

/**
 * KeyDelivery — tabela "legal"."key_deliveries"
 * Controle de entrega/liberação de chaves de um imóvel locado.
 * SEM lock_version — ver comentário de decisão de engenharia na migration
 * 20260101000090-create-legal-key_deliveries.js.
 */
module.exports = (sequelize) => {
  const KeyDelivery = sequelize.define(
    'KeyDelivery',
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
      contractId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'contract_id',
      },
      inspectionId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'inspection_id',
      },
      deliveredToPersonId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'delivered_to_person_id',
      },
      deliveredByUserId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'delivered_by_user_id',
      },
      deliveredAt: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'delivered_at',
      },
      status: {
        type: DataTypes.STRING(32),
        allowNull: false,
        defaultValue: 'PENDING',
        field: 'status',
        comment: "PENDING|RELEASED",
      },
      notes: {
        type: DataTypes.TEXT,
        allowNull: true,
        field: 'notes',
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
      schema: 'legal',
      tableName: 'key_deliveries',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      paranoid: true,
      deletedAt: 'deleted_at',
      underscored: true,
    }
  );

  return KeyDelivery;
};
