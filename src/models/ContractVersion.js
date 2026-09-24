'use strict';

const { DataTypes } = require('sequelize');

/**
 * ContractVersion — tabela "legal"."contract_versions"
 * Versão imutável de um contrato (aditivos geram nova versão, nunca edição da anterior).
 */
module.exports = (sequelize) => {
  const ContractVersion = sequelize.define(
    'ContractVersion',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
        allowNull: false,
      },
      groupId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'group_id',
      },
      companyId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'company_id',
      },
      contractId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'contract_id',
      },
      versionNumber: {
        type: DataTypes.INTEGER,
        allowNull: false,
        field: 'version_number',
      },
      documentFileId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'document_file_id',
      },
      contentHash: {
        type: DataTypes.STRING(64),
        allowNull: true,
        field: 'content_hash',
      },
      // Texto de verdade da versão (cláusulas renderizadas) — ver migration
      // 20260101000179. Persistido pra permitir reconstruir o PDF do contrato SOB DEMANDA
      // (contractPdf.service.js, pdfkit em memória) sem depender de storage de binário: mesmo
      // texto -> mesmo PDF -> mesmo hash, sempre reconstruível de forma determinística.
      content: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      // Documento ASSINADO baixado do provedor (Clicksign/ZapSign) quando o envelope fecha —
      // ver migration 20260101000180. Diferente do PDF não-assinado (nunca persistido, sempre
      // reconstruído sob demanda a partir de `content`), este É persistido permanentemente em
      // disco (uploads/contracts-signed/...) porque carrega a trilha de evidência do provedor
      // (carimbos/hashes/timestamps de assinatura) — não é reconstruível a partir do nosso
      // texto. Ver signatures.service.js#handleEnvelopeClosedWebhook.
      signedDocumentFileId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'signed_document_file_id',
      },
      templateId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'template_id',
        comment: 'FK opcional para legal.contract_templates — modelo que originou esta versão (ver migration 20260101000178).',
      },
      effectiveFrom: {
        type: DataTypes.DATE,
        allowNull: false,
        field: 'effective_from',
      },
      createdBy: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'created_by',
      },
      updatedBy: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'updated_by',
      },
    },
    {
      schema: 'legal',
      tableName: 'contract_versions',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      underscored: true,
    }
  );

  return ContractVersion;
};
