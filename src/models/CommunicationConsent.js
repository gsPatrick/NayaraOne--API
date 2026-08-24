'use strict';

const { DataTypes } = require('sequelize');

/**
 * CommunicationConsent — tabela "people"."communication_consents"
 * Registro de opt-in/opt-out por pessoa/canal/finalidade (CRMX-008). Nome confirmado pelo
 * Caderno; colunas são inferência — ver comentário na migration
 * 20260101000088-create-people-communication_consents.js.
 */
module.exports = (sequelize) => {
  const CommunicationConsent = sequelize.define(
    'CommunicationConsent',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
        allowNull: false,
      },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      personId: { type: DataTypes.UUID, allowNull: false, field: 'person_id' },
      channel: { type: DataTypes.STRING(30), allowNull: false, field: 'channel', comment: 'PHONE|WHATSAPP|EMAIL' },
      purpose: { type: DataTypes.STRING(50), allowNull: false, field: 'purpose' },
      status: { type: DataTypes.STRING(20), allowNull: false, field: 'status', comment: 'OPT_IN|OPT_OUT' },
      recordedAt: { type: DataTypes.DATE, allowNull: false, field: 'recorded_at' },
      createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
      updatedBy: { type: DataTypes.UUID, allowNull: true, field: 'updated_by' },
    },
    {
      schema: 'people',
      tableName: 'communication_consents',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      underscored: true,
    }
  );

  return CommunicationConsent;
};
