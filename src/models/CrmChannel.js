'use strict';

const { DataTypes } = require('sequelize');

/** CrmChannel — "crm"."channels" (Marco 9, M9-D230 3.5): a linha da empresa num canal de atendimento, com identificador INTERNO estável (o par externo vive em crm.conversation_links). */
module.exports = (sequelize) => sequelize.define(
  'CrmChannel',
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
    groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
    companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
    kind: { type: DataTypes.STRING(32), allowNull: false, defaultValue: 'WHATSAPP' },
  },
  { schema: 'crm', tableName: 'channels', timestamps: true, createdAt: 'created_at', updatedAt: 'updated_at', underscored: true }
);
