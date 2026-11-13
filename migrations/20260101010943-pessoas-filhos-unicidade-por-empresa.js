'use strict';

/**
 * Unicidades dos dados filhos de Pessoa por pessoa E empresa (DI-M9I-3): com a pessoa do grupo vinculada a mais de uma
 * empresa (CRMX-015), cada empresa tem os próprios filhos dela. Duas unicidades eram só por pessoa e passariam a misturar as
 * empresas: "um endereço atual por pessoa" (person_addresses_one_current_per_person_uk, migration 20260101000174) e "versão
 * do documento" (person_id, document_type, version_no; migration 20260101000086). Sem esta troca, o endereço atual ou o RG
 * v1 da empresa A barrariam os da empresa B, e o erro revelaria a B que eles existem. O serviço já calcula versão e endereço
 * atual dentro da empresa (RLS), então a regra de cada empresa continua a mesma.
 * O down volta às unicidades por pessoa e PARA (sem alterar nada) se duas empresas já tiverem o mesmo tipo e versão de
 * documento ou dois endereços atuais da mesma pessoa.
 */
module.exports = {
  up: async (queryInterface) => {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q('DROP INDEX IF EXISTS people.person_addresses_one_current_per_person_uk');
      await q('CREATE UNIQUE INDEX person_addresses_one_current_per_person_uk ON people.person_addresses (person_id, company_id) WHERE is_current = true');
      await q('ALTER TABLE people.person_documents DROP CONSTRAINT IF EXISTS person_documents_person_id_document_type_version_no_key');
      await q('ALTER TABLE people.person_documents DROP CONSTRAINT IF EXISTS person_documents_person_company_type_version_key');
      await q(`ALTER TABLE people.person_documents ADD CONSTRAINT person_documents_person_company_type_version_key
        UNIQUE (person_id, company_id, document_type, version_no)`);
    });
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q('ALTER TABLE people.person_documents DROP CONSTRAINT IF EXISTS person_documents_person_company_type_version_key');
      await q(`ALTER TABLE people.person_documents ADD CONSTRAINT person_documents_person_id_document_type_version_no_key
        UNIQUE (person_id, document_type, version_no)`);
      await q('DROP INDEX IF EXISTS people.person_addresses_one_current_per_person_uk');
      await q('CREATE UNIQUE INDEX person_addresses_one_current_per_person_uk ON people.person_addresses (person_id) WHERE is_current = true');
    });
  },
};
