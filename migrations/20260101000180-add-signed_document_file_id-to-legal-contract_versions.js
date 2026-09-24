'use strict';

/**
 * Migration: adiciona `signed_document_file_id` (UUID, nullable, FK -> people.files) em
 * "legal"."contract_versions".
 *
 * DIFERENÇA DELIBERADA em relação ao PDF não-assinado (ver contractPdf.service.js): o PDF
 * não-assinado é reconstruível sob demanda a partir de `content` (texto), então NUNCA é
 * persistido. O documento ASSINADO é outra coisa — vem do provedor de assinatura (Clicksign/
 * ZapSign) já com a trilha de evidência do provedor embutida (carimbos, hashes, timestamps de
 * cada assinatura), e não é reconstruível a partir do nosso texto. Por isso esse SIM precisa
 * ser baixado uma única vez (quando o envelope fecha) e guardado permanentemente em disco
 * (uploads/contracts-signed/..., ver diskStorage.js) — perdê-lo significa perder a prova de
 * assinatura de verdade, não um "documento regenerável".
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn(
      { tableName: 'contract_versions', schema: 'legal' },
      'signed_document_file_id',
      {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: { tableName: 'files', schema: 'people' }, key: 'id' },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
      }
    );
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn({ tableName: 'contract_versions', schema: 'legal' }, 'signed_document_file_id');
  },
};
