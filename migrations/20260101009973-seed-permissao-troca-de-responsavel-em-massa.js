'use strict';

const { forceRestaurado } = require('../src/shared/db/forceRestaurado');
const { randomUUID } = require('crypto');

/**
 * Migration (livro do Marco 3 §18 "Trocar responsável em massa — Permissão específica + audit"): permissão dedicada
 * "crm:opportunities:reassign" para a troca de responsável em lote (POST /crm/opportunities/reassign) + concessão ao ADMIN.
 * Mesmo padrão de 20260101000633. A troca unitária pela edição da oportunidade continua com crm:opportunities:update.
 */
const CODE = 'crm:opportunities:reassign';
const DESCRIPTION = 'Trocar em lote o corretor responsável de várias oportunidades (cada troca auditada com antes/depois e motivo).';
const RISK = 'HIGH';

module.exports = {
  up: async (queryInterface) => {
    const sequelize = queryInterface.sequelize;

    await sequelize.query(
      `INSERT INTO core.permissions (id, code, description, risk_level, created_at, updated_at)
       SELECT :id, :code, :description, :risk, now(), now()
       WHERE NOT EXISTS (SELECT 1 FROM core.permissions WHERE code = :code)`,
      { replacements: { id: randomUUID(), code: CODE, description: DESCRIPTION, risk: RISK } }
    );

    await sequelize.query('ALTER TABLE core.companies NO FORCE ROW LEVEL SECURITY');
    await sequelize.query('ALTER TABLE core.roles NO FORCE ROW LEVEL SECURITY');
    await forceRestaurado(async () => {
      await sequelize.query(
        `
        INSERT INTO core.role_permissions (id, role_id, permission_id, created_at, updated_at)
        SELECT gen_random_uuid(), r.id, p.id, now(), now()
        FROM core.roles r
        CROSS JOIN core.permissions p
        WHERE r.name = 'ADMIN'
          AND p.code = :code
          AND NOT EXISTS (
            SELECT 1 FROM core.role_permissions rp
            WHERE rp.role_id = r.id AND rp.permission_id = p.id
          )
        `,
        { replacements: { code: CODE } }
      );
    }, async () => {
      await sequelize.query('ALTER TABLE core.companies FORCE ROW LEVEL SECURITY');
      await sequelize.query('ALTER TABLE core.roles FORCE ROW LEVEL SECURITY');
    });
  },

  down: async () => {
    // Concessão/catálogo de permissão não é revertido automaticamente.
  },
};
