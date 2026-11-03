'use strict';

const { DataTypes } = require('sequelize');

/**
 * CaseApplicant — tabela "correspondent"."case_applicants" (Marco 8). Proponente de um
 * financing_case, sempre vinculado a um cadastro real de "people"."persons" — nunca texto
 * livre (mesmo cuidado documentado em PADRAO_COMPONENTES_E_REGRAS.md após o bug grave de
 * proprietário de imóvel no Marco 3).
 */
module.exports = (sequelize) => {
  const CaseApplicant = sequelize.define(
    'CaseApplicant',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      financingCaseId: { type: DataTypes.UUID, allowNull: false, field: 'financing_case_id' },
      personId: { type: DataTypes.UUID, allowNull: false, field: 'person_id' },
      role: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'PRINCIPAL', field: 'role' },
    },
    {
      schema: 'correspondent',
      tableName: 'case_applicants',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      underscored: true,
    }
  );
  return CaseApplicant;
};
