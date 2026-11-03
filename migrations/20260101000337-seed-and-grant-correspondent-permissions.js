'use strict';

const { randomUUID } = require('crypto');

/**
 * Migration: catálogo de permissões "correspondent:*" (Marco 8) + concessão ao papel ADMIN.
 * Mesmo bug de classe já corrigido para construction/finance/inventory/procurement — sem a
 * concessão explícita ao ADMIN, nenhum usuário consegue usar os endpoints mesmo com o código
 * funcionando. Ver 20260101000256-seed-and-grant-inventory-permissions.js como referência.
 */
const CODES = [
  ['correspondent:create', 'Criar casos de financiamento, proponentes e documentos do Correspondente Bancário.', 'MEDIUM'],
  ['correspondent:read', 'Consultar casos de financiamento, simulações e status do Correspondente Bancário.', 'LOW'],
];

module.exports = {
  up: async (queryInterface) => {
    const sequelize = queryInterface.sequelize;

    for (const [code, description, risk] of CODES) {
      await sequelize.query(
        `INSERT INTO core.permissions (id, code, description, risk_level, created_at, updated_at)
         SELECT :id, :code, :description, :risk, now(), now()
         WHERE NOT EXISTS (SELECT 1 FROM core.permissions WHERE code = :code)`,
        { replacements: { id: randomUUID(), code, description, risk } }
      );
    }

    await sequelize.query('ALTER TABLE core.companies NO FORCE ROW LEVEL SECURITY');
    await sequelize.query('ALTER TABLE core.roles NO FORCE ROW LEVEL SECURITY');
    try {
      await sequelize.query(
        `
        INSERT INTO core.role_permissions (id, role_id, permission_id, created_at, updated_at)
        SELECT gen_random_uuid(), r.id, p.id, now(), now()
        FROM core.roles r
        CROSS JOIN core.permissions p
        WHERE r.name = 'ADMIN'
          AND p.code = ANY(ARRAY[:codes])
          AND NOT EXISTS (
            SELECT 1 FROM core.role_permissions rp
            WHERE rp.role_id = r.id AND rp.permission_id = p.id
          )
        `,
        { replacements: { codes: CODES.map((c) => c[0]) } }
      );
    } finally {
      await sequelize.query('ALTER TABLE core.companies FORCE ROW LEVEL SECURITY');
      await sequelize.query('ALTER TABLE core.roles FORCE ROW LEVEL SECURITY');
    }
  },

  down: async () => {
    // Concessão/catálogo de permissão não é revertido automaticamente.
  },
};
