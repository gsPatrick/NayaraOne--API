'use strict';

const { DataTypes } = require('sequelize');

/** ClauseLibrary — tabela "legal"."clause_library" (Caderno M5 §4, migration 9983): a cláusula (código) e o responsável jurídico. */
module.exports = (sequelize) => sequelize.define(
  'ClauseLibrary',
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
    groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
    companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
    code: { type: DataTypes.STRING(64), allowNull: false, field: 'code' },
    legalResponsibleUserId: { type: DataTypes.UUID, allowNull: true, field: 'legal_responsible_user_id' },
    createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
  },
  { schema: 'legal', tableName: 'clause_library', timestamps: true, createdAt: 'created_at', updatedAt: 'updated_at', underscored: true }
);
