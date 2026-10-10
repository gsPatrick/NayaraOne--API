'use strict';

const { DataTypes } = require('sequelize');

/**
 * Notice — tabela "legal"."notices"
 * Notificação formal (Caderno Anexo I "13. Aditivos e notificações") vinculada a um Contract
 * OU a um LegalCase. "Notificação possui canal, destinatário, conteúdo/arquivo, data e
 * evidência de envio/recebimento quando disponível." / "IA pode rascunhar; envio jurídico
 * sensível requer revisão humana" — ver notices.service.js.
 *
 * NOTA DE AMBIENTE (07/10/2026): migration 20260101000292 PRONTA mas AINDA NÃO aplicada neste
 * banco — mesma limitação documentada em ContractRequirement.js.
 */
module.exports = (sequelize) => {
  const Notice = sequelize.define(
    'Notice',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
        allowNull: false,
      },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      contractId: { type: DataTypes.UUID, allowNull: true, field: 'contract_id' },
      legalCaseId: { type: DataTypes.UUID, allowNull: true, field: 'legal_case_id' },
      channel: { type: DataTypes.STRING(32), allowNull: false, field: 'channel' },
      recipientPersonId: { type: DataTypes.UUID, allowNull: true, field: 'recipient_person_id' },
      recipientDescription: { type: DataTypes.TEXT, allowNull: true, field: 'recipient_description' },
      content: { type: DataTypes.TEXT, allowNull: true, field: 'content' },
      contentFileId: { type: DataTypes.UUID, allowNull: true, field: 'content_file_id' },
      isLegallySensitive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: 'is_legally_sensitive' },
      status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'DRAFT', field: 'status' },
      draftedByAi: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: 'drafted_by_ai' },
      reviewedByUserId: { type: DataTypes.UUID, allowNull: true, field: 'reviewed_by_user_id' },
      reviewedAt: { type: DataTypes.DATE, allowNull: true, field: 'reviewed_at' },
      sentAt: { type: DataTypes.DATE, allowNull: true, field: 'sent_at' },
      sentByUserId: { type: DataTypes.UUID, allowNull: true, field: 'sent_by_user_id' },
      deliveryEvidenceFileId: { type: DataTypes.UUID, allowNull: true, field: 'delivery_evidence_file_id' },
      deliveredAt: { type: DataTypes.DATE, allowNull: true, field: 'delivered_at' },
      createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
      updatedBy: { type: DataTypes.UUID, allowNull: true, field: 'updated_by' },
    },
    {
      schema: 'legal',
      tableName: 'notices',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      paranoid: true,
      deletedAt: 'deleted_at',
      underscored: true,
    }
  );

  return Notice;
};
