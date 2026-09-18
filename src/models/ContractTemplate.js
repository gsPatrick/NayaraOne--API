'use strict';

const { DataTypes } = require('sequelize');

/**
 * ContractTemplate — tabela "legal"."contract_templates"
 * Modelo de contrato por tipo (SALE|LEASE|SERVICE), composto por cláusulas da biblioteca via
 * a junção legal.contract_template_clauses (ver ContractTemplateClause).
 */
module.exports = (sequelize) => {
  const ContractTemplate = sequelize.define(
    'ContractTemplate',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      name: { type: DataTypes.STRING(255), allowNull: false, field: 'name' },
      contractType: { type: DataTypes.STRING(32), allowNull: false, field: 'contract_type' },
      isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true, field: 'is_active' },
      createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
      updatedBy: { type: DataTypes.UUID, allowNull: true, field: 'updated_by' },
    },
    {
      schema: 'legal',
      tableName: 'contract_templates',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      underscored: true,
    }
  );

  return ContractTemplate;
};
