'use strict';

/**
 * Migration: auditoria externa (contrato bruto, Anexo I "10. Entrega de chaves") —
 * "Registrar quantidade/identificação de chaves/controles", "Fotos obrigatórias quando
 * política exigir", "Assinatura do termo de entrega". Hoje `legal.key_deliveries` só tinha
 * status/data/observações — nada estruturado para a quantidade/identificação das chaves
 * entregues, nem para o termo assinado (releaseKeyDelivery marcava RELEASED sem nenhum
 * registro formal de "termo assinado").
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn({ tableName: 'key_deliveries', schema: 'legal' }, 'keys_count', {
      type: Sequelize.INTEGER,
      allowNull: true,
    });
    await queryInterface.addColumn({ tableName: 'key_deliveries', schema: 'legal' }, 'keys_identification', {
      type: Sequelize.TEXT,
      allowNull: true,
    });
    await queryInterface.addColumn({ tableName: 'key_deliveries', schema: 'legal' }, 'photos_required', {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    });
    await queryInterface.addColumn({ tableName: 'key_deliveries', schema: 'legal' }, 'photos_file_ids', {
      type: Sequelize.JSONB,
      allowNull: true,
    });
    await queryInterface.addColumn({ tableName: 'key_deliveries', schema: 'legal' }, 'term_type', {
      type: Sequelize.STRING(32),
      allowNull: true,
      comment: 'KEY_DELIVERY|USED_PROPERTY_DELIVERY',
    });
    await queryInterface.addColumn({ tableName: 'key_deliveries', schema: 'legal' }, 'term_signed_at', {
      type: Sequelize.DATE,
      allowNull: true,
    });
    await queryInterface.addColumn({ tableName: 'key_deliveries', schema: 'legal' }, 'term_signed_by_person_id', {
      type: Sequelize.UUID,
      allowNull: true,
    });
  },

  down: async (queryInterface) => {
    for (const column of [
      'keys_count',
      'keys_identification',
      'photos_required',
      'photos_file_ids',
      'term_type',
      'term_signed_at',
      'term_signed_by_person_id',
    ]) {
      await queryInterface.removeColumn({ tableName: 'key_deliveries', schema: 'legal' }, column);
    }
  },
};
