'use strict';

const { DataTypes } = require('sequelize');

/**
 * ContractTemplateClause — tabela "legal"."contract_template_clauses"
 * Junção template x cláusula com ordem explícita (`sortOrder`) usada por renderTemplate.
 * Aponta para a VERSÃO específica da cláusula (contract_clauses.id é único por versão).
 */
module.exports = (sequelize) => {
  const ContractTemplateClause = sequelize.define(
    'ContractTemplateClause',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      contractTemplateId: { type: DataTypes.UUID, allowNull: false, field: 'contract_template_id' },
      contractClauseId: { type: DataTypes.UUID, allowNull: false, field: 'contract_clause_id' },
      sortOrder: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'sort_order' },
      createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
    },
    {
      schema: 'legal',
      tableName: 'contract_template_clauses',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: false,
      underscored: true,
    }
  );

  return ContractTemplateClause;
};
