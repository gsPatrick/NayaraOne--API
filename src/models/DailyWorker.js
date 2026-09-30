'use strict';

const { DataTypes } = require('sequelize');

/**
 * DailyWorker — tabela "construction"."daily_workers"
 * Equipe do dia de um RDO, vinculada a Pessoa/Fornecedor (people.persons).
 */
module.exports = (sequelize) => {
  const DailyWorker = sequelize.define(
    'DailyWorker',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
        allowNull: false,
      },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      dailyReportId: { type: DataTypes.UUID, allowNull: false, field: 'daily_report_id' },
      personId: { type: DataTypes.UUID, allowNull: false, field: 'person_id' },
      role: { type: DataTypes.STRING(128), allowNull: true, field: 'role' },
      // Achado numa rodada de verificação de integrações (30/09/2026): a fonte exige
      // "documentação correspondente" vinculada ao prestador, além da Pessoa em si.
      documentFileIds: { type: DataTypes.ARRAY(DataTypes.UUID), allowNull: false, defaultValue: [], field: 'document_file_ids' },
      createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
      updatedBy: { type: DataTypes.UUID, allowNull: true, field: 'updated_by' },
      deletedBy: { type: DataTypes.UUID, allowNull: true, field: 'deleted_by' },
    },
    {
      schema: 'construction',
      tableName: 'daily_workers',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      paranoid: true,
      deletedAt: 'deleted_at',
      underscored: true,
    }
  );

  return DailyWorker;
};
