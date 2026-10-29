'use strict';

const { DataTypes } = require('sequelize');

/**
 * AiServiceIdentity — tabela "ai"."service_identities" (M9-D017): identidade de serviço da NAY por empresa e agente, usada em
 * tarefa automática. Só leitura: a CHECK do banco recusa permissão que não termine em read, view ou list.
 */
module.exports = (sequelize) => sequelize.define(
  'AiServiceIdentity',
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
    groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
    companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
    agentCode: { type: DataTypes.STRING(60), allowNull: false, field: 'agent_code' },
    permissions: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
    enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
    updatedBy: { type: DataTypes.UUID, allowNull: true, field: 'updated_by' },
  },
  { schema: 'ai', tableName: 'service_identities', timestamps: true, underscored: true }
);
