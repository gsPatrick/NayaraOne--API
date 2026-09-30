'use strict';

const { DataTypes } = require('sequelize');

/**
 * DailyReport — tabela "construction"."daily_reports"
 * RDO (Relatório Diário de Obra) — um por projeto por dia.
 */
module.exports = (sequelize) => {
  const DailyReport = sequelize.define(
    'DailyReport',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
        allowNull: false,
      },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      projectId: { type: DataTypes.UUID, allowNull: false, field: 'project_id' },
      reportDate: { type: DataTypes.DATEONLY, allowNull: false, field: 'report_date' },
      shiftCode: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'UNICO', field: 'shift_code' },
      weather: { type: DataTypes.STRING(32), allowNull: true, field: 'weather' },
      workforceCount: { type: DataTypes.INTEGER, allowNull: true, field: 'workforce_count' },
      // A fonte separa "serviços" (o que foi executado) de "ocorrências e bloqueios" —
      // achado numa rodada de verificação de integrações, campo próprio ausente até então.
      servicesPerformed: { type: DataTypes.TEXT, allowNull: true, field: 'services_performed' },
      occurrences: { type: DataTypes.TEXT, allowNull: true, field: 'occurrences' },
      // Achado numa rodada de verificação de integrações (30/09/2026): a fonte exige que o
      // diário registre "fotos" — campo ausente até então (não é divergência de nome, é campo
      // inteiro faltando).
      evidenceFileIds: { type: DataTypes.ARRAY(DataTypes.UUID), allowNull: false, defaultValue: [], field: 'evidence_file_ids' },
      reportedByUserId: { type: DataTypes.UUID, allowNull: true, field: 'reported_by_user_id' },
      // M6-20: correção nunca sobrescreve — aponta para o registro que esta linha substitui.
      supersedesId: { type: DataTypes.UUID, allowNull: true, field: 'supersedes_id' },
      // M6-94: captura offline — ID local do app + chave de idempotência de sincronização.
      clientLocalId: { type: DataTypes.STRING(128), allowNull: true, field: 'client_local_id' },
      idempotencyKey: { type: DataTypes.STRING(128), allowNull: true, field: 'idempotency_key' },
      lockVersion: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'lock_version' },
      createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
      updatedBy: { type: DataTypes.UUID, allowNull: true, field: 'updated_by' },
      deletedBy: { type: DataTypes.UUID, allowNull: true, field: 'deleted_by' },
    },
    {
      schema: 'construction',
      tableName: 'daily_reports',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      paranoid: true,
      deletedAt: 'deleted_at',
      version: 'lockVersion',
      underscored: true,
    }
  );

  return DailyReport;
};
