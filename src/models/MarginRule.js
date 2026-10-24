'use strict';

const { DataTypes } = require('sequelize');

/**
 * MarginRule — tabela "construction"."margin_rules"
 * Versão vigente (ou histórica) da margem mínima exigida para aprovar orçamento de obra.
 * Ver DECISÃO DE ENGENHARIA no cabeçalho da migração 20260101000181 — cada linha é uma versão
 * imutável; o próprio `id` é o `rule_version_id` gravado em "construction"."budgets" no
 * momento da aprovação (M6-23/M6-61).
 */
module.exports = (sequelize) => {
  const MarginRule = sequelize.define(
    'MarginRule',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
        allowNull: false,
      },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      minMarginPct: { type: DataTypes.DECIMAL(5, 2), allowNull: false, field: 'min_margin_pct' },
      // TAREFA 2 (auditoria externa Nayara, fechamento Marco 6): "economia" (economyPct) e
      // "comissão" (commissionPct) da obra foram adicionadas à tabela física via migração
      // 20260101000303 (colunas `economy_pct`/`commission_pct`, nullable). NÃO são declaradas
      // como atributos deste model Sequelize de propósito: este model é só um ESPELHO de
      // compatibilidade de FK legada (a fonte real da verdade é
      // `core.rule_versions.action_json` — ver DECISÃO DE ENGENHARIA no topo de
      // marginRules.service.js), e este ambiente de execução não tem permissão de ALTER TABLE
      // pra rodar a migração contra o banco compartilhado (mesma limitação já documentada ali
      // — `ERROR: permission denied for schema public` com o usuário de runtime). Declarar os
      // atributos aqui faria QUALQUER `MarginRule.create()` quebrar agora (o `RETURNING` do
      // INSERT do Sequelize lista TODAS as colunas do model, inclusive as que ainda não
      // existem fisicamente) — então o espelho continua só com os campos que já existem de
      // verdade na tabela, e os dois campos novos só moram no Motor de Regras genérico
      // (funcional e testado via marginRules.service.js/economyPct,commissionPct). Quando a
      // migração puder ser aplicada, adicionar aqui `economyPct`/`commissionPct` e passar a
      // gravá-los no espelho em `createMarginRuleAttempt` é seguro e imediato.
      description: { type: DataTypes.STRING(255), allowNull: true, field: 'description' },
      isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true, field: 'is_active' },
      lockVersion: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'lock_version' },
      createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
      updatedBy: { type: DataTypes.UUID, allowNull: true, field: 'updated_by' },
      deletedBy: { type: DataTypes.UUID, allowNull: true, field: 'deleted_by' },
    },
    {
      schema: 'construction',
      tableName: 'margin_rules',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      paranoid: true,
      deletedAt: 'deleted_at',
      version: 'lockVersion',
      underscored: true,
    }
  );

  return MarginRule;
};
