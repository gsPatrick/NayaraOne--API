'use strict';

const { DataTypes } = require('sequelize');

/**
 * Substitution — tabela "core"."substitutions"
 * Substituição temporária de responsabilidade/aprovação entre usuários (férias, licença).
 */
module.exports = (sequelize) => {
  const Substitution = sequelize.define(
    'Substitution',
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
      substituteUserId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'substitute_user_id',
        comment: "Usuário que assume",
      },
      originalUserId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'original_user_id',
        comment: "Usuário substituído",
      },
      startsAt: {
        type: DataTypes.DATE,
        allowNull: false,
        field: 'starts_at',
      },
      endsAt: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'ends_at',
      },
      reason: {
        type: DataTypes.TEXT,
        allowNull: true,
        field: 'reason',
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
      tableName: 'substitutions',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      paranoid: true,
      deletedAt: 'deleted_at',
      underscored: true,
    }
  );

  return Substitution;
};
