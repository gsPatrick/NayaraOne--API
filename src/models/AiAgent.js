'use strict';

const { DataTypes } = require('sequelize');

/**
 * AiAgent — tabela "ai"."agents" (M9-D004): uma linha por VERSÃO de agente da NAY.
 * company_id/group_id nulos = padrão do sistema (leitura liberada pela RLS a toda empresa). A imutabilidade fora de DRAFT e as
 * transições de estado são garantidas por gatilho no banco (ai.agents_guard).
 */
module.exports = (sequelize) => sequelize.define(
  'AiAgent',
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
    groupId: { type: DataTypes.UUID, allowNull: true, field: 'group_id' },
    companyId: { type: DataTypes.UUID, allowNull: true, field: 'company_id' },
    code: { type: DataTypes.STRING(60), allowNull: false },
    version: { type: DataTypes.INTEGER, allowNull: false },
    status: { type: DataTypes.STRING(12), allowNull: false, defaultValue: 'DRAFT' },
    purpose: { type: DataTypes.TEXT, allowNull: false },
    systemPolicy: { type: DataTypes.TEXT, allowNull: false, defaultValue: '', field: 'system_policy' },
    modelPolicy: { type: DataTypes.JSONB, allowNull: false, defaultValue: {}, field: 'model_policy' },
    permissions: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
    dataScopes: { type: DataTypes.JSONB, allowNull: false, defaultValue: [], field: 'data_scopes' },
    limits: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
    criticality: { type: DataTypes.STRING(12), allowNull: false, defaultValue: 'NON_CRITICAL' },
    enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    configHash: { type: DataTypes.CHAR(64), allowNull: false, field: 'config_hash' },
    idempotencyKey: { type: DataTypes.STRING(200), allowNull: true, field: 'idempotency_key' },
    createdFromVersion: { type: DataTypes.INTEGER, allowNull: true, field: 'created_from_version' },
    homologatedBy: { type: DataTypes.UUID, allowNull: true, field: 'homologated_by' },
    homologatedAt: { type: DataTypes.DATE, allowNull: true, field: 'homologated_at' },
    homologationNote: { type: DataTypes.TEXT, allowNull: true, field: 'homologation_note' },
    activatedBy: { type: DataTypes.UUID, allowNull: true, field: 'activated_by' },
    activatedAt: { type: DataTypes.DATE, allowNull: true, field: 'activated_at' },
    retiredBy: { type: DataTypes.UUID, allowNull: true, field: 'retired_by' },
    retiredAt: { type: DataTypes.DATE, allowNull: true, field: 'retired_at' },
    createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
    updatedBy: { type: DataTypes.UUID, allowNull: true, field: 'updated_by' },
  },
  { schema: 'ai', tableName: 'agents', timestamps: true, underscored: true }
);
