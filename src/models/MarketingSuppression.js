'use strict';

const { DataTypes } = require('sequelize');

/**
 * MarketingSuppression — tabela "marketing"."suppression_list".
 * Lista de supressão (M9-D401): quem não pode receber mensagem. Guarda o SHA-256 do endereço normalizado, nunca o endereço.
 */
module.exports = (sequelize) => {
  const MarketingSuppression = sequelize.define(
    'MarketingSuppression',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      personId: { type: DataTypes.UUID, allowNull: true, field: 'person_id' },
      addressHash: { type: DataTypes.CHAR(64), allowNull: false, field: 'address_hash' },
      channel: { type: DataTypes.STRING(16), allowNull: false, field: 'channel' },
      purpose: { type: DataTypes.STRING(40), allowNull: true, field: 'purpose' },
      reason: { type: DataTypes.STRING(12), allowNull: false, field: 'reason' },
      source: { type: DataTypes.STRING(120), allowNull: false, field: 'source' },
      active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true, field: 'active' },
      expiresAt: { type: DataTypes.DATE, allowNull: true, field: 'expires_at' },
      liftedBy: { type: DataTypes.UUID, allowNull: true, field: 'lifted_by' },
      liftedAt: { type: DataTypes.DATE, allowNull: true, field: 'lifted_at' },
      createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
      updatedBy: { type: DataTypes.UUID, allowNull: true, field: 'updated_by' },
    },
    {
      schema: 'marketing',
      tableName: 'suppression_list',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      paranoid: true,
      deletedAt: 'deleted_at',
      underscored: true,
    }
  );

  return MarketingSuppression;
};
