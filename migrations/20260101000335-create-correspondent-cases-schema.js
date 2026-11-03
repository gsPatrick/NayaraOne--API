'use strict';

/**
 * Migration: Marco 8 fase 1 (Caderno "CORRESPONDENTE BANCÁRIO + NC + FINANCIAMENTOS") — núcleo
 * de dados de financiamento. O schema "correspondent" já é referenciado pelas settings da Fase
 * 0 (`correspondent.financing_provider`), mas nunca foi criado por nenhuma migration até aqui —
 * esta é a primeira a criar o schema de fato, seguindo o mesmo padrão de
 * `20260101000267-create-procurement-schema.js`.
 *
 * financing_cases: um registro por operação de financiamento (Caderno: "Um financing_case por
 * operação; múltiplas simulações ficam versionadas" — simulations é Fase 3, fora de escopo
 * aqui). case_applicants: proponentes do financiamento, sempre vinculados a um cadastro real de
 * `people.persons` (nunca texto livre — mesmo cuidado já documentado em
 * PADRAO_COMPONENTES_E_REGRAS.md após o bug grave de proprietário de imóvel no Marco 3).
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.sequelize.query('CREATE SCHEMA IF NOT EXISTS "correspondent";');

    const tenantCols = (extra = {}) => ({
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true, allowNull: false },
      group_id: {
        type: Sequelize.UUID, allowNull: false,
        references: { model: { tableName: 'groups', schema: 'core' }, key: 'id' }, onDelete: 'RESTRICT', onUpdate: 'CASCADE',
      },
      company_id: {
        type: Sequelize.UUID, allowNull: false,
        references: { model: { tableName: 'companies', schema: 'core' }, key: 'id' }, onDelete: 'RESTRICT', onUpdate: 'CASCADE',
      },
      ...extra,
    });

    const enableRls = async (table) => {
      await queryInterface.sequelize.query(`ALTER TABLE "correspondent"."${table}" ENABLE ROW LEVEL SECURITY;`);
      await queryInterface.sequelize.query(`ALTER TABLE "correspondent"."${table}" FORCE ROW LEVEL SECURITY;`);
      await queryInterface.sequelize.query(`
        CREATE POLICY tenant_isolation ON "correspondent"."${table}"
          USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);
      `);
    };

    await queryInterface.createTable({ tableName: 'financing_cases', schema: 'correspondent' }, tenantCols({
      property_id: {
        type: Sequelize.UUID, allowNull: true,
        references: { model: { tableName: 'properties', schema: 'real_estate' }, key: 'id' }, onDelete: 'RESTRICT', onUpdate: 'CASCADE',
      },
      provider_code: { type: Sequelize.STRING(32), allowNull: false, defaultValue: 'sandbox', comment: 'Código do ProviderAdapter (Fase 0) — "sandbox"|"manual" nesta fase.' },
      status: {
        type: Sequelize.STRING(24), allowNull: false, defaultValue: 'DRAFT',
        comment: 'DRAFT|DOCUMENTS_PENDING|READY_TO_SUBMIT|SUBMITTED|UNDER_ANALYSIS|PENDING_CUSTOMER|PENDING_PROPERTY|APPROVED|REJECTED|CONTRACTING|COMPLETED|CANCELED (máquina completa é Fase 6; aqui só DRAFT é alcançável).',
      },
      lock_version: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      created_by: { type: Sequelize.UUID, allowNull: true },
      updated_by: { type: Sequelize.UUID, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
    }));
    await enableRls('financing_cases');

    await queryInterface.createTable({ tableName: 'case_applicants', schema: 'correspondent' }, tenantCols({
      financing_case_id: {
        type: Sequelize.UUID, allowNull: false,
        references: { model: { tableName: 'financing_cases', schema: 'correspondent' }, key: 'id' }, onDelete: 'CASCADE', onUpdate: 'CASCADE',
      },
      person_id: {
        type: Sequelize.UUID, allowNull: false,
        references: { model: { tableName: 'persons', schema: 'people' }, key: 'id' }, onDelete: 'RESTRICT', onUpdate: 'CASCADE',
      },
      role: { type: Sequelize.STRING(16), allowNull: false, defaultValue: 'PRINCIPAL', comment: 'PRINCIPAL|CO_APPLICANT' },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
    }));
    // Mesmo proponente não pode ser adicionado duas vezes ao mesmo caso.
    await queryInterface.addConstraint({ tableName: 'case_applicants', schema: 'correspondent' }, {
      fields: ['financing_case_id', 'person_id'],
      type: 'unique',
      name: 'case_applicants_case_person_unique',
    });
    await enableRls('case_applicants');
  },

  down: async (queryInterface) => {
    const dropWithPolicy = async (table) => {
      await queryInterface.sequelize.query(`DROP POLICY IF EXISTS tenant_isolation ON "correspondent"."${table}";`);
      await queryInterface.sequelize.query(`ALTER TABLE "correspondent"."${table}" DISABLE ROW LEVEL SECURITY;`);
      await queryInterface.dropTable({ tableName: table, schema: 'correspondent' });
    };
    await dropWithPolicy('case_applicants');
    await dropWithPolicy('financing_cases');
  },
};
