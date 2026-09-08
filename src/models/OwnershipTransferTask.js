'use strict';

const { DataTypes } = require('sequelize');

/**
 * OwnershipTransferTask — tabela "finance"."ownership_transfer_tasks". Tarefa de transferência
 * de titularidade de utilidade ao mudar locatário/proprietário. O closeout de locação
 * (closeout.service.js) bloqueia o encerramento do contrato enquanto houver tarefa PENDING.
 */
module.exports = (sequelize) => {
  const OwnershipTransferTask = sequelize.define(
    'OwnershipTransferTask',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      utilityObligationId: { type: DataTypes.UUID, allowNull: false, field: 'utility_obligation_id' },
      fromPersonId: { type: DataTypes.UUID, allowNull: true, field: 'from_person_id' },
      toPersonId: { type: DataTypes.UUID, allowNull: true, field: 'to_person_id' },
      status: { type: DataTypes.STRING(32), allowNull: false, defaultValue: 'PENDING', field: 'status' },
      completedAt: { type: DataTypes.DATE, allowNull: true, field: 'completed_at' },
      lockVersion: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'lock_version' },
      createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
      updatedBy: { type: DataTypes.UUID, allowNull: true, field: 'updated_by' },
      deletedBy: { type: DataTypes.UUID, allowNull: true, field: 'deleted_by' },
    },
    {
      schema: 'finance',
      tableName: 'ownership_transfer_tasks',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      paranoid: true,
      deletedAt: 'deleted_at',
      version: 'lockVersion',
      underscored: true,
    }
  );

  return OwnershipTransferTask;
};
