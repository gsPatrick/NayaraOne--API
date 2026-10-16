'use strict';

const { DataTypes } = require('sequelize');

/**
 * ExternalCaseRouting — tabela "correspondent"."external_case_routing" (Marco 8 Fase 6).
 * DELIBERADAMENTE SEM RLS (ver migration 20260101000345) — mapeamento mínimo e não sensível
 * (só IDs) usado SÓ pra resolver o tenant de um webhook antes de abrir a transação com `SET
 * LOCAL`. Nunca é fonte de verdade de negócio.
 */
module.exports = (sequelize) => {
  const ExternalCaseRouting = sequelize.define(
    'ExternalCaseRouting',
    {
      externalCaseId: { type: DataTypes.STRING(160), primaryKey: true, allowNull: false, field: 'external_case_id' },
      providerCode: { type: DataTypes.STRING(32), allowNull: false, field: 'provider_code' },
      financingCaseId: { type: DataTypes.UUID, allowNull: false, field: 'financing_case_id' },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
    },
    {
      schema: 'correspondent',
      tableName: 'external_case_routing',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: false,
      underscored: true,
    }
  );
  return ExternalCaseRouting;
};
