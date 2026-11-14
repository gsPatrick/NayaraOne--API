'use strict';

const { DataTypes } = require('sequelize');

/**
 * Opportunity — tabela "crm"."opportunities"
 * Oportunidade comercial (funil de vendas/locação) associada a um cliente e opcionalmente a um imóvel.
 */
module.exports = (sequelize) => {
  const Opportunity = sequelize.define(
    'Opportunity',
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
      personId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'person_id',
        comment: "Cliente/lead",
      },
      propertyId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'property_id',
      },
      ownerUserId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'owner_user_id',
        comment: "Corretor/responsável",
      },
      stage: {
        type: DataTypes.STRING(32),
        allowNull: false,
        defaultValue: 'NEW',
        field: 'stage',
      },
      temperature: {
        type: DataTypes.STRING(16),
        allowNull: true,
        field: 'temperature',
        comment: "COLD|WARM|HOT",
      },
      expectedValue: {
        type: DataTypes.DECIMAL(18, 2),
        allowNull: true,
        field: 'expected_value',
      },
      closedAt: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'closed_at',
      },
      lostReason: {
        type: DataTypes.TEXT,
        allowNull: true,
        field: 'lost_reason',
        comment: 'Motivo estruturado de PERDA (enum LOST) — obrigatório ao entrar em LOST (M3-12).',
      },
      wonReason: {
        type: DataTypes.STRING(32),
        allowNull: true,
        field: 'won_reason',
        comment: 'Motivo estruturado de GANHO (enum WON) — obrigatório ao entrar em WON (M3-12).',
      },
      withdrawnReason: {
        type: DataTypes.STRING(32),
        allowNull: true,
        field: 'withdrawn_reason',
        comment: 'Motivo estruturado de DESISTÊNCIA (categoria desistência de crm.motivos.desistencia) — preenchido quando a perda (LOST) é desistência (M3-12).',
      },
      nextAction: {
        type: DataTypes.TEXT,
        allowNull: true,
        field: 'next_action',
        comment: "Obrigatório na aplicação enquanto a opportunity está em estágio ativo (não WON/LOST).",
      },
      nextActionDueAt: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'next_action_due_at',
      },
      // CAD-09 (Marco 3 §9): retrato do financiamento vinculado, escrito só pelo consumidor do evento do Correspondente
      // (crm/financingStatus.consumer.js). Só referência, status e data — nenhum dado bancário no CRM.
      financingCaseId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'financing_case_id',
      },
      financingStatus: {
        type: DataTypes.STRING(32),
        allowNull: true,
        field: 'financing_status',
      },
      financingStatusAt: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'financing_status_at',
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
      schema: 'crm',
      tableName: 'opportunities',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      paranoid: true,
      deletedAt: 'deleted_at',
      version: 'lockVersion',
      underscored: true,
    }
  );

  return Opportunity;
};
