'use strict';

const { DataTypes } = require('sequelize');

/**
 * MaintenanceCase — tabela "construction"."maintenance_cases"
 * Chamado de manutenção/pós-obra vinculado a um imóvel/projeto, dentro do prazo de garantia.
 */
module.exports = (sequelize) => {
  const MaintenanceCase = sequelize.define(
    'MaintenanceCase',
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
        allowNull: false,
        field: 'property_id',
      },
      projectId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'project_id',
      },
      openedByPersonId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'opened_by_person_id',
      },
      responsibleUserId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'responsible_user_id',
      },
      description: {
        type: DataTypes.TEXT,
        allowNull: false,
        field: 'description',
      },
      status: {
        type: DataTypes.STRING(32),
        allowNull: false,
        defaultValue: 'OPEN',
        field: 'status',
      },
      warrantyDeadlineAt: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'warranty_deadline_at',
      },
      category: {
        type: DataTypes.STRING(64),
        allowNull: true,
        field: 'category',
      },
      severity: {
        type: DataTypes.STRING(16),
        allowNull: false,
        defaultValue: 'MEDIUM',
        field: 'severity',
      },
      slaDueAt: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'sla_due_at',
      },
      escalationLevel: {
        type: DataTypes.STRING(16),
        allowNull: false,
        defaultValue: 'NONE',
        field: 'escalation_level',
      },
      beforeMediaFileIds: {
        type: DataTypes.ARRAY(DataTypes.UUID),
        allowNull: false,
        defaultValue: [],
        field: 'before_media_file_ids',
      },
      afterMediaFileIds: {
        type: DataTypes.ARRAY(DataTypes.UUID),
        allowNull: false,
        defaultValue: [],
        field: 'after_media_file_ids',
      },
      laborCost: {
        type: DataTypes.DECIMAL(14, 2),
        allowNull: true,
        field: 'labor_cost',
      },
      materialCost: {
        type: DataTypes.DECIMAL(14, 2),
        allowNull: true,
        field: 'material_cost',
      },
      rootCauseCode: {
        type: DataTypes.STRING(64),
        allowNull: true,
        field: 'root_cause_code',
      },
      // Achado numa rodada de verificação de integrações (30/09/2026): "Desconto/ressarcimento
      // passa por regra/aprovação e Financeiro" — funcionalidade inteira ausente até então.
      resolutionType: {
        type: DataTypes.STRING(16), // DISCOUNT | REIMBURSEMENT
        allowNull: true,
        field: 'resolution_type',
      },
      resolutionAmount: {
        type: DataTypes.DECIMAL(18, 2),
        allowNull: true,
        field: 'resolution_amount',
      },
      resolutionStatus: {
        type: DataTypes.STRING(24), // PENDING_APPROVAL | APPROVED
        allowNull: true,
        field: 'resolution_status',
      },
      resolutionApprovedByUserId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'resolution_approved_by_user_id',
      },
      resolutionFinancialEntryId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'resolution_financial_entry_id',
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
      tableName: 'maintenance_cases',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      paranoid: true,
      deletedAt: 'deleted_at',
      version: 'lockVersion',
      underscored: true,
    }
  );

  return MaintenanceCase;
};
