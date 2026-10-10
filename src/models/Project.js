'use strict';

const { DataTypes } = require('sequelize');

/**
 * Project — tabela "construction"."projects"
 * Obra/empreendimento de construção civil.
 */
module.exports = (sequelize) => {
  const Project = sequelize.define(
    'Project',
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
      propertyId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'property_id',
      },
      // M6-95: dimensão unit_id além de group_id/company_id — relacionamento raiz
      // group -> company -> unit; nullable porque nem toda empresa opera com unidades.
      unitId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'unit_id',
      },
      name: {
        type: DataTypes.STRING(255),
        allowNull: false,
        field: 'name',
      },
      responsibleUserId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'responsible_user_id',
      },
      budgetAmount: {
        type: DataTypes.DECIMAL(18, 2),
        allowNull: true,
        field: 'budget_amount',
      },
      startsAt: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'starts_at',
      },
      endsAtPlanned: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'ends_at_planned',
      },
      // M6-01 (fechado 30/09/2026): código legível único por empresa (ex.: OBRA-2026-0001),
      // gerado automaticamente em createProject via generateProjectCode() quando não informado.
      code: {
        type: DataTypes.STRING(40),
        allowNull: true,
        field: 'code',
      },
      actualEndDate: {
        type: DataTypes.DATEONLY,
        allowNull: true,
        field: 'actual_end_date',
      },
      // M6-97 (reforço): centro de custo padrão da obra — "Centro de custo obrigatório para
      // despesa" é regra transversal do Financeiro; lançamentos gerados por Obras (medições
      // aprovadas) usam este valor quando a medição não tiver um próprio.
      costCenterId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'cost_center_id',
      },
      status: {
        type: DataTypes.STRING(32),
        allowNull: false,
        defaultValue: 'PLANNED',
        field: 'status',
      },
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
      tableName: 'projects',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      paranoid: true,
      deletedAt: 'deleted_at',
      version: 'lockVersion',
      underscored: true,
    }
  );

  return Project;
};
