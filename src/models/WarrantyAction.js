'use strict';

const { DataTypes } = require('sequelize');

/**
 * WarrantyAction — tabela "construction"."warranty_actions" (M6-15/M6-16/M6-26).
 * Histórico de ações de atendimento (visita técnica, reparo, troca de material etc)
 * realizadas dentro de um chamado de garantia (`MaintenanceCase`/WarrantyCase), cada uma com
 * custo próprio.
 */
module.exports = (sequelize) => {
  const WarrantyAction = sequelize.define(
    'WarrantyAction',
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
      warrantyCaseId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'warranty_case_id',
      },
      description: {
        type: DataTypes.TEXT,
        allowNull: false,
        field: 'description',
      },
      performedByUserId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'performed_by_user_id',
      },
      performedAt: {
        type: DataTypes.DATE,
        allowNull: false,
        field: 'performed_at',
      },
      cost: {
        type: DataTypes.DECIMAL(14, 2),
        allowNull: true,
        field: 'cost',
      },
      // Nota (item 2): assigned_team/material_used ainda não são atributos deste model porque a
      // migration que cria essas colunas ainda não foi aplicada no banco neste momento. Veja
      // warrantyActionTeamMaterialColumns.js — leitura/escrita feita por SQL direto, guardada
      // por checagem de existência, até a migration ser aplicada.
      lockVersion: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        field: 'lock_version',
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
      tableName: 'warranty_actions',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      paranoid: true,
      deletedAt: 'deleted_at',
      version: 'lockVersion',
      underscored: true,
    }
  );

  return WarrantyAction;
};
