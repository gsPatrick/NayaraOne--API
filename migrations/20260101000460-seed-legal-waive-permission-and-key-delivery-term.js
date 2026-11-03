'use strict';

const { randomUUID } = require('crypto');

/**
 * Frente 5 (Marco 5 — Regras do Jurídico):
 *  1. Permissão própria `legal:waive` para DISPENSAR requisito do checklist documental
 *     (antes bastava legal:update). Seed no catálogo + concessão ao papel ADMIN.
 *  2. Entrega de chaves: política de fotos e texto do termo passam a ser definidos pelo
 *     SERVIDOR — colunas para guardar o termo gerado (texto, versão, hash) e a política aplicada.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const sequelize = queryInterface.sequelize;
    const now = new Date();
    await queryInterface.bulkInsert(
      { tableName: 'permissions', schema: 'core' },
      [{
        id: randomUUID(),
        code: 'legal:waive',
        description: 'Dispensar (WAIVED) requisito do checklist documental de contrato, com motivo.',
        risk_level: 'HIGH',
        created_at: now,
        updated_at: now,
      }],
      { ignoreDuplicates: true }
    );

    await sequelize.query('ALTER TABLE core.companies NO FORCE ROW LEVEL SECURITY');
    await sequelize.query('ALTER TABLE core.roles NO FORCE ROW LEVEL SECURITY');
    try {
      await sequelize.query(`
        INSERT INTO core.role_permissions (id, role_id, permission_id, created_at, updated_at)
        SELECT gen_random_uuid(), r.id, p.id, now(), now()
        FROM core.roles r CROSS JOIN core.permissions p
        WHERE r.name = 'ADMIN' AND p.code = 'legal:waive'
          AND NOT EXISTS (SELECT 1 FROM core.role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = p.id)
      `);
    } finally {
      await sequelize.query('ALTER TABLE core.companies FORCE ROW LEVEL SECURITY');
      await sequelize.query('ALTER TABLE core.roles FORCE ROW LEVEL SECURITY');
    }

    const table = { tableName: 'key_deliveries', schema: 'legal' };
    const cols = await queryInterface.describeTable(table);
    if (!cols.term_text) await queryInterface.addColumn(table, 'term_text', { type: Sequelize.TEXT, allowNull: true });
    if (!cols.term_version) await queryInterface.addColumn(table, 'term_version', { type: Sequelize.STRING(32), allowNull: true });
    if (!cols.term_hash) await queryInterface.addColumn(table, 'term_hash', { type: Sequelize.STRING(64), allowNull: true });
    if (!cols.photo_policy) await queryInterface.addColumn(table, 'photo_policy', { type: Sequelize.STRING(64), allowNull: true });

    const [[{ exists }]] = await sequelize.query("SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') AS exists;");
    if (exists) {
      await sequelize.query('GRANT SELECT, INSERT, UPDATE ON "legal"."key_deliveries" TO nayara_runtime;');
    }
  },

  down: async (queryInterface) => {
    const table = { tableName: 'key_deliveries', schema: 'legal' };
    for (const col of ['term_text', 'term_version', 'term_hash', 'photo_policy']) {
      await queryInterface.removeColumn(table, col);
    }
  },
};
