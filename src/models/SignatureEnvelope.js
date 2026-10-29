'use strict';

const { DataTypes } = require('sequelize');

/**
 * SignatureEnvelope — "legal"."signature_envelopes" (Marco 9, M9-D236): o envelope pedido ao fornecedor de assinatura para uma versão aprovada do contrato, com o hash
 * enviado, o par (connection, id externo) e o estado (PENDING, SIGNED, CANCELLED, HASH_MISMATCH).
 */
module.exports = (sequelize) => sequelize.define(
  'SignatureEnvelope',
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
    groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
    companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
    contractVersionId: { type: DataTypes.UUID, allowNull: false, field: 'contract_version_id' },
    connectionId: { type: DataTypes.UUID, allowNull: true, field: 'connection_id' },
    providerCode: { type: DataTypes.STRING(48), allowNull: false, field: 'provider_code' },
    externalEnvelopeId: { type: DataTypes.STRING(160), allowNull: true, field: 'external_envelope_id' },
    documentSha256: { type: DataTypes.CHAR(64), allowNull: false, field: 'document_sha256' },
    status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'PENDING' },
    signedSha256: { type: DataTypes.CHAR(64), allowNull: true, field: 'signed_sha256' },
    originalConfirmedSha256: { type: DataTypes.CHAR(64), allowNull: true, field: 'original_confirmed_sha256' },
    signedDocumentFileId: { type: DataTypes.UUID, allowNull: true, field: 'signed_document_file_id' },
    dispatchId: { type: DataTypes.UUID, allowNull: true, field: 'dispatch_id' },
  },
  { schema: 'legal', tableName: 'signature_envelopes', timestamps: true, createdAt: 'created_at', updatedAt: 'updated_at', underscored: true }
);
