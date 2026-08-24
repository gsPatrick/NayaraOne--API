'use strict';

/**
 * Migration: alinha "people"."person_roles" ao schema confirmado (TAB-0101).
 * - role -> role_code (varchar(50)); valores confirmados (base, lista aberta): CLIENTE,
 *   PROPRIETARIO, LOCATARIO, FORNECEDOR (citação literal do Caderno, sem tradução) — mais
 *   CORRETOR, já usado no mock do frontend.
 * - PK confirmada: PRIMARY KEY(person_id, role_code, company_id). Isso exige company_id NOT
 *   NULL (colunas de PK composta não podem ser NULL em Postgres) — diverge do "company_id NULL"
 *   citado na DDL da tabela; decisão documentada: mantemos NOT NULL porque é membro da PK
 *   confirmada, e a coluna já era NOT NULL na implementação anterior.
 * - a coluna "id" (uuid) é mantida como identificador estável para a API (rotas
 *   /people/:id/roles/:roleId já a usam), mas deixa de ser PK — vira UNIQUE.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.sequelize.query(`
      UPDATE "people"."person_roles" SET role = CASE role
        WHEN 'CLIENT' THEN 'CLIENTE'
        WHEN 'OWNER' THEN 'PROPRIETARIO'
        WHEN 'TENANT' THEN 'LOCATARIO'
        WHEN 'SUPPLIER' THEN 'FORNECEDOR'
        WHEN 'BROKER' THEN 'CORRETOR'
        ELSE role
      END;
    `);
    await queryInterface.renameColumn({ tableName: 'person_roles', schema: 'people' }, 'role', 'role_code');
    await queryInterface.changeColumn(
      { tableName: 'person_roles', schema: 'people' },
      'role_code',
      { type: Sequelize.STRING(50), allowNull: false }
    );

    await queryInterface.sequelize.query('ALTER TABLE "people"."person_roles" DROP CONSTRAINT person_roles_pkey;');
    await queryInterface.addConstraint(
      { tableName: 'person_roles', schema: 'people' },
      { fields: ['id'], type: 'unique', name: 'person_roles_id_key' }
    );
    await queryInterface.addConstraint(
      { tableName: 'person_roles', schema: 'people' },
      { fields: ['person_id', 'role_code', 'company_id'], type: 'primary key', name: 'person_roles_pkey' }
    );
  },

  down: async (queryInterface, Sequelize) => {
    await queryInterface.sequelize.query('ALTER TABLE "people"."person_roles" DROP CONSTRAINT person_roles_pkey;');
    await queryInterface.removeConstraint({ tableName: 'person_roles', schema: 'people' }, 'person_roles_id_key');
    await queryInterface.addConstraint(
      { tableName: 'person_roles', schema: 'people' },
      { fields: ['id'], type: 'primary key', name: 'person_roles_pkey' }
    );

    await queryInterface.changeColumn(
      { tableName: 'person_roles', schema: 'people' },
      'role_code',
      { type: Sequelize.STRING(32), allowNull: false }
    );
    await queryInterface.renameColumn({ tableName: 'person_roles', schema: 'people' }, 'role_code', 'role');
    await queryInterface.sequelize.query(`
      UPDATE "people"."person_roles" SET role = CASE role
        WHEN 'CLIENTE' THEN 'CLIENT'
        WHEN 'PROPRIETARIO' THEN 'OWNER'
        WHEN 'LOCATARIO' THEN 'TENANT'
        WHEN 'FORNECEDOR' THEN 'SUPPLIER'
        WHEN 'CORRETOR' THEN 'BROKER'
        ELSE role
      END;
    `);
  },
};
