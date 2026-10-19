'use strict';

const { randomUUID } = require('crypto');

/**
 * Régua de cobrança (REG-LOC-004) exposta via HTTP: permissão própria `billing:cadence:manage`
 * para PUBLICAR nova versão da régua (leitura usa billing:read). Seed no catálogo + ADMIN.
 */
module.exports = {
  up: async (queryInterface) => {
    const sequelize = queryInterface.sequelize;
    const now = new Date();
    await queryInterface.bulkInsert(
      { tableName: 'permissions', schema: 'core' },
      [{
        id: randomUUID(),
        code: 'billing:cadence:manage',
        description: 'Publicar nova versão da régua de cobrança de locação (etapas/prazos/ações).',
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
        WHERE r.name = 'ADMIN' AND p.code = 'billing:cadence:manage'
          AND NOT EXISTS (SELECT 1 FROM core.role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = p.id)
      `);
    } finally {
      await sequelize.query('ALTER TABLE core.companies FORCE ROW LEVEL SECURITY');
      await sequelize.query('ALTER TABLE core.roles FORCE ROW LEVEL SECURITY');
    }
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query(`
      DELETE FROM core.role_permissions WHERE permission_id IN (SELECT id FROM core.permissions WHERE code = 'billing:cadence:manage');
      DELETE FROM core.permissions WHERE code = 'billing:cadence:manage';
    `);
  },
};
