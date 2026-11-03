'use strict';

/** Marco 8 — registra o envio de cada documento necessário ao provider (uploadDocument opcional do adapter). */
module.exports = {
  up: async (queryInterface) => {
    await queryInterface.sequelize.query(`ALTER TABLE "correspondent"."case_documents"
      ADD COLUMN IF NOT EXISTS provider_external_document_id VARCHAR(128),
      ADD COLUMN IF NOT EXISTS sent_to_provider_at TIMESTAMPTZ`);
  },
  down: async (queryInterface) => {
    await queryInterface.sequelize.query(`ALTER TABLE "correspondent"."case_documents"
      DROP COLUMN IF EXISTS sent_to_provider_at, DROP COLUMN IF EXISTS provider_external_document_id`);
  },
};
