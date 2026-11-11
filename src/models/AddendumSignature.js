'use strict';

const { DataTypes } = require('sequelize');

/** AddendumSignature — tabela "legal"."addendum_signatures" (Caderno M5 §13, migration 9984): assinatura por signatário do aditivo. Imutável. */
module.exports = (sequelize) => sequelize.define(
  'AddendumSignature',
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
    groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
    companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
    addendumId: { type: DataTypes.UUID, allowNull: false, field: 'addendum_id' },
    personId: { type: DataTypes.UUID, allowNull: false, field: 'person_id' },
    partyRole: { type: DataTypes.STRING(16), allowNull: false, field: 'party_role' },
    evidenceFileId: { type: DataTypes.UUID, allowNull: false, field: 'evidence_file_id' },
    collectedByUserId: { type: DataTypes.UUID, allowNull: false, field: 'collected_by_user_id' },
    signedAt: { type: DataTypes.DATE, allowNull: false, field: 'signed_at' },
  },
  { schema: 'legal', tableName: 'addendum_signatures', timestamps: true, createdAt: 'created_at', updatedAt: false, underscored: true }
);
