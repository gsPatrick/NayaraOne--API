'use strict';

const { DataTypes } = require('sequelize');
const { encryptNote, decryptNote } = require('../utils/caseDocumentCrypto');

/**
 * CaseDocument — tabela "correspondent"."case_documents" (Marco 8 Fase 2). Versão de um
 * arquivo enviado pra um case_requirement. Nunca é UPDATE: uma nova versão sempre é uma nova
 * linha, com a anterior marcada em `supersededAt` (preserva histórico, índice único parcial no
 * banco garante no máximo uma versão vigente por requirement).
 */
module.exports = (sequelize) => {
  const CaseDocument = sequelize.define(
    'CaseDocument',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      financingCaseId: { type: DataTypes.UUID, allowNull: false, field: 'financing_case_id' },
      requirementId: { type: DataTypes.UUID, allowNull: false, field: 'requirement_id' },
      fileId: { type: DataTypes.UUID, allowNull: false, field: 'file_id' },
      version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
      classification: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'RESTRICTED' },
      supersededAt: { type: DataTypes.DATE, allowNull: true, field: 'superseded_at' },
      expiresAt: { type: DataTypes.DATE, allowNull: true, field: 'expires_at' },
      uploadedBy: { type: DataTypes.UUID, allowNull: true, field: 'uploaded_by' },
      duplicateOfDocumentId: { type: DataTypes.UUID, allowNull: true, field: 'duplicate_of_document_id' },
      providerExternalDocumentId: { type: DataTypes.STRING(128), allowNull: true, field: 'provider_external_document_id' },
      sentToProviderAt: { type: DataTypes.DATE, allowNull: true, field: 'sent_to_provider_at' },
      readingStatus: { type: DataTypes.STRING(16), allowNull: true, field: 'reading_status' },
      readingFoundFields: { type: DataTypes.JSONB, allowNull: true, field: 'reading_found_fields' },
      // A leitura automática (nome, CPF, renda, conta) é dado de identidade/renda: guardada CIFRADA
      // (AES-256-GCM) e decifrada só ao ler pelo modelo. Linhas antigas em texto claro continuam legíveis.
      suggestedNote: {
        type: DataTypes.TEXT,
        allowNull: true,
        field: 'suggested_note',
        get() {
          const raw = this.getDataValue('suggestedNote');
          if (!raw || !/^enc2?:/.test(String(raw))) return raw;
          try {
            return decryptNote(raw);
          } catch (err) {
            // eslint-disable-next-line no-console
            console.error('[CaseDocument] Não foi possível decifrar a leitura automática de um documento (chave alterada ou dado corrompido).');
            return null;
          }
        },
        set(value) {
          this.setDataValue('suggestedNote', value ? encryptNote(value) : value);
        },
      },
    },
    {
      schema: 'correspondent',
      tableName: 'case_documents',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      underscored: true,
    }
  );
  return CaseDocument;
};
