'use strict';

/**
 * Migration: cria "legal"."contract_number_sequences" — contador atômico usado para gerar
 * `contracts.contract_number` no formato {PREFIXO}-{ANO}-{SEQ:04d} (ver contracts.service.js,
 * generateContractNumber). Sequencial reinicia por (company_id, contract_type, year).
 *
 * DECISÃO DE ENGENHARIA: usamos uma tabela de contador dedicada com UNIQUE
 * (company_id, contract_type, year) + `INSERT ... ON CONFLICT DO UPDATE ... RETURNING`
 * (upsert atômico de uma única instrução SQL) em vez de `SELECT ... FOR UPDATE` porque o
 * upsert atômico não precisa de uma linha pré-existente para travar — a primeira criação do
 * ano/tipo já nasce sem corrida (INSERT simples colide com o UNIQUE e vira UPDATE atômico na
 * mesma instrução, sem round-trip extra de "verificar se existe, senão criar").
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable(
      { tableName: 'contract_number_sequences', schema: 'legal' },
      {
        id: {
          type: Sequelize.UUID,
          defaultValue: Sequelize.UUIDV4,
          primaryKey: true,
          allowNull: false,
        },
        company_id: {
          type: Sequelize.UUID,
          allowNull: false,
          references: { model: { tableName: 'companies', schema: 'core' }, key: 'id' },
          onDelete: 'RESTRICT',
          onUpdate: 'CASCADE',
        },
        contract_type: { type: Sequelize.STRING(32), allowNull: false, comment: 'SALE|LEASE|SERVICE' },
        year: { type: Sequelize.INTEGER, allowNull: false },
        last_seq: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      }
    );

    await queryInterface.addConstraint(
      { tableName: 'contract_number_sequences', schema: 'legal' },
      {
        fields: ['company_id', 'contract_type', 'year'],
        type: 'unique',
        name: 'contract_number_sequences_company_type_year_unique',
      }
    );

    await queryInterface.sequelize.query('ALTER TABLE "legal"."contract_number_sequences" ENABLE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query('ALTER TABLE "legal"."contract_number_sequences" FORCE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query(`
      CREATE POLICY tenant_isolation ON "legal"."contract_number_sequences"
        USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP POLICY IF EXISTS tenant_isolation ON "legal"."contract_number_sequences";');
    await queryInterface.sequelize.query('ALTER TABLE "legal"."contract_number_sequences" DISABLE ROW LEVEL SECURITY;');
    await queryInterface.dropTable({ tableName: 'contract_number_sequences', schema: 'legal' });
  },
};
