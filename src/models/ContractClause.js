'use strict';

const { DataTypes } = require('sequelize');

/**
 * ContractClause — tabela "legal"."contract_clauses"
 * Cláusula da biblioteca contratual. APPEND-ONLY POR VERSÃO: `body_text` nunca é atualizado;
 * uma "edição" cria uma nova linha com o mesmo `code` e `version_number + 1` (ver
 * contractClauses.service.js). Por isso o model não tem updated_at nem soft delete.
 */
module.exports = (sequelize) => {
  const ContractClause = sequelize.define(
    'ContractClause',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      code: { type: DataTypes.STRING(64), allowNull: false, field: 'code' },
      title: { type: DataTypes.STRING(255), allowNull: false, field: 'title' },
      bodyText: { type: DataTypes.TEXT, allowNull: false, field: 'body_text' },
      category: { type: DataTypes.STRING(32), allowNull: false, field: 'category' },
      versionNumber: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1, field: 'version_number' },
      isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true, field: 'is_active' },
      createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
    },
    {
      schema: 'legal',
      tableName: 'contract_clauses',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: false,
      underscored: true,
    }
  );

  return ContractClause;
};
