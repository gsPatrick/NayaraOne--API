'use strict';

const { DataTypes } = require('sequelize');

/**
 * RuleException — tabela "core"."rule_exceptions"
 * Exceção temporária a uma regra, com alvo, justificativa e prazo definidos.
 */
module.exports = (sequelize) => {
  const RuleException = sequelize.define(
    'RuleException',
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
      ruleId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'rule_id',
      },
      targetEntityType: {
        type: DataTypes.STRING(64),
        allowNull: false,
        field: 'target_entity_type',
      },
      targetEntityId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'target_entity_id',
      },
      justification: {
        type: DataTypes.TEXT,
        allowNull: false,
        field: 'justification',
      },
      startsAt: {
        type: DataTypes.DATE,
        allowNull: false,
        field: 'starts_at',
      },
      endsAt: {
        type: DataTypes.DATE,
        allowNull: false,
        field: 'ends_at',
      },
      approvedByUserId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'approved_by_user_id',
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
      schema: 'core',
      tableName: 'rule_exceptions',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      paranoid: true,
      deletedAt: 'deleted_at',
      underscored: true,
    }
  );

  return RuleException;
};
