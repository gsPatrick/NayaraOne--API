'use strict';

/**
 * Migration: alinha "people"."persons" ao schema confirmado do Caderno Técnico (TAB-0100).
 * - type -> person_type (varchar(10), "PF"/"PJ" em vez de INDIVIDUAL/COMPANY).
 * - name -> legal_name.
 * - adiciona preferred_name (nome de uso/fantasia).
 * - tax_id -> tax_id_normalized (varchar(20)).
 * - adiciona tax_id_normalized_hash (HMAC do documento, para busca exata sem expor valor em
 *   claro — regra de segurança explícita do documento, mesmo não estando na DDL principal).
 * - birth_date (timestamptz) -> birth_or_foundation_date (date).
 * - adiciona merged_into_id (auto-FK, preenchido quando status=MERGED) e risk_flags_json (jsonb).
 * - troca a policy única "tenant_isolation" pelo par confirmado no Caderno:
 *   persons_company_select (usa company_scope_allows) / persons_company_write (usa só group_id).
 *   company_scope_allows não existe ainda no banco — criada aqui como função SQL simples
 *   (company_id = target_company_id), documentando que essa é uma simplificação: o Caderno não
 *   detalha a implementação dessa função auxiliar.
 * - adiciona UNIQUE(group_id, tax_id_normalized) WHERE tax_id_normalized IS NOT NULL.
 *
 * Decisão registrada: "company_id" já existia na tabela (migration 000023) — não é uma coluna
 * nova introduzida por engano; permanece porque a policy de SELECT confirmada no Caderno a
 * referencia diretamente.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.renameColumn({ tableName: 'persons', schema: 'people' }, 'type', 'person_type');
    await queryInterface.changeColumn(
      { tableName: 'persons', schema: 'people' },
      'person_type',
      { type: Sequelize.STRING(10), allowNull: false, defaultValue: 'PF' }
    );
    await queryInterface.sequelize.query(`
      UPDATE "people"."persons" SET person_type = CASE person_type WHEN 'INDIVIDUAL' THEN 'PF' WHEN 'COMPANY' THEN 'PJ' ELSE person_type END;
    `);

    await queryInterface.renameColumn({ tableName: 'persons', schema: 'people' }, 'name', 'legal_name');
    await queryInterface.changeColumn(
      { tableName: 'persons', schema: 'people' },
      'legal_name',
      { type: Sequelize.STRING(200), allowNull: false }
    );

    await queryInterface.addColumn(
      { tableName: 'persons', schema: 'people' },
      'preferred_name',
      { type: Sequelize.STRING(150), allowNull: true }
    );

    await queryInterface.renameColumn({ tableName: 'persons', schema: 'people' }, 'tax_id', 'tax_id_normalized');
    await queryInterface.changeColumn(
      { tableName: 'persons', schema: 'people' },
      'tax_id_normalized',
      { type: Sequelize.STRING(20), allowNull: true }
    );
    await queryInterface.addColumn(
      { tableName: 'persons', schema: 'people' },
      'tax_id_normalized_hash',
      { type: Sequelize.STRING(128), allowNull: true }
    );

    await queryInterface.renameColumn({ tableName: 'persons', schema: 'people' }, 'birth_date', 'birth_or_foundation_date');
    await queryInterface.changeColumn(
      { tableName: 'persons', schema: 'people' },
      'birth_or_foundation_date',
      { type: Sequelize.DATEONLY, allowNull: true }
    );

    await queryInterface.addColumn(
      { tableName: 'persons', schema: 'people' },
      'merged_into_id',
      {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: { tableName: 'persons', schema: 'people' }, key: 'id' },
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
      }
    );
    await queryInterface.addColumn(
      { tableName: 'persons', schema: 'people' },
      'risk_flags_json',
      { type: Sequelize.JSONB, allowNull: true }
    );

    await queryInterface.sequelize.query(`
      CREATE UNIQUE INDEX persons_group_id_tax_id_normalized_key
        ON "people"."persons" (group_id, tax_id_normalized)
        WHERE tax_id_normalized IS NOT NULL;
    `);

    // company_scope_allows: simplificação documentada — o Caderno não detalha a implementação;
    // comportamento equivalente ao padrão de RLS por company_id já usado em todo o projeto.
    await queryInterface.sequelize.query(`
      CREATE OR REPLACE FUNCTION company_scope_allows(row_company_id uuid, ctx_company_id uuid)
      RETURNS boolean AS $$
        SELECT ctx_company_id IS NOT NULL AND row_company_id = ctx_company_id;
      $$ LANGUAGE sql IMMUTABLE;
    `);

    await queryInterface.sequelize.query('DROP POLICY IF EXISTS tenant_isolation ON "people"."persons";');
    await queryInterface.sequelize.query(`
      CREATE POLICY persons_company_select ON "people"."persons" FOR SELECT
        USING (
          group_id = NULLIF(current_setting('app.group_id', true), '')::uuid
          AND company_scope_allows(company_id, NULLIF(current_setting('app.company_id', true), '')::uuid)
        );
    `);
    await queryInterface.sequelize.query(`
      CREATE POLICY persons_company_write ON "people"."persons" FOR ALL
        USING (group_id = NULLIF(current_setting('app.group_id', true), '')::uuid)
        WITH CHECK (group_id = NULLIF(current_setting('app.group_id', true), '')::uuid);
    `);
  },

  down: async (queryInterface, Sequelize) => {
    await queryInterface.sequelize.query('DROP POLICY IF EXISTS persons_company_select ON "people"."persons";');
    await queryInterface.sequelize.query('DROP POLICY IF EXISTS persons_company_write ON "people"."persons";');
    await queryInterface.sequelize.query(`
      CREATE POLICY tenant_isolation ON "people"."persons"
        USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);
    `);
    await queryInterface.sequelize.query('DROP FUNCTION IF EXISTS company_scope_allows(uuid, uuid);');

    await queryInterface.sequelize.query('DROP INDEX IF EXISTS "people".persons_group_id_tax_id_normalized_key;');

    await queryInterface.removeColumn({ tableName: 'persons', schema: 'people' }, 'risk_flags_json');
    await queryInterface.removeColumn({ tableName: 'persons', schema: 'people' }, 'merged_into_id');

    await queryInterface.changeColumn(
      { tableName: 'persons', schema: 'people' },
      'birth_or_foundation_date',
      { type: Sequelize.DATE, allowNull: true }
    );
    await queryInterface.renameColumn({ tableName: 'persons', schema: 'people' }, 'birth_or_foundation_date', 'birth_date');

    await queryInterface.removeColumn({ tableName: 'persons', schema: 'people' }, 'tax_id_normalized_hash');
    await queryInterface.changeColumn(
      { tableName: 'persons', schema: 'people' },
      'tax_id_normalized',
      { type: Sequelize.STRING(32), allowNull: true }
    );
    await queryInterface.renameColumn({ tableName: 'persons', schema: 'people' }, 'tax_id_normalized', 'tax_id');

    await queryInterface.removeColumn({ tableName: 'persons', schema: 'people' }, 'preferred_name');

    await queryInterface.changeColumn(
      { tableName: 'persons', schema: 'people' },
      'legal_name',
      { type: Sequelize.STRING(255), allowNull: false }
    );
    await queryInterface.renameColumn({ tableName: 'persons', schema: 'people' }, 'legal_name', 'name');

    await queryInterface.sequelize.query(`
      UPDATE "people"."persons" SET person_type = CASE person_type WHEN 'PF' THEN 'INDIVIDUAL' WHEN 'PJ' THEN 'COMPANY' ELSE person_type END;
    `);
    await queryInterface.changeColumn(
      { tableName: 'persons', schema: 'people' },
      'person_type',
      { type: Sequelize.STRING(16), allowNull: false, defaultValue: 'INDIVIDUAL' }
    );
    await queryInterface.renameColumn({ tableName: 'persons', schema: 'people' }, 'person_type', 'type');
  },
};
