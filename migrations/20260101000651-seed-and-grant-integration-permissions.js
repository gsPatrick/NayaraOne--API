'use strict';

const { randomUUID } = require('crypto');

/**
 * Marco 9, M9-D200 — permissões integration:read e integration:manage + concessão ao ADMIN.
 * Mesmo padrão de 20260101000633.
 */
const PERMISSIONS = [
  { code: 'integration:read', description: 'Ver o registro de integrações (fornecedores e conexões da empresa), sem nenhum segredo.', risk: 'LOW' },
  { code: 'integration:manage', description: 'Criar, alterar, ativar, pausar e desativar conexões de integração da empresa; administrar o catálogo de fornecedores da plataforma.', risk: 'HIGH' },
];

module.exports = {
  up: async (queryInterface) => {
    const sequelize = queryInterface.sequelize;
    for (const p of PERMISSIONS) {
      await sequelize.query(
        `INSERT INTO core.permissions (id, code, description, risk_level, created_at, updated_at)
         SELECT :id, :code, :description, :risk, now(), now()
         WHERE NOT EXISTS (SELECT 1 FROM core.permissions WHERE code = :code)`,
        { replacements: { id: randomUUID(), code: p.code, description: p.description, risk: p.risk } }
      );
    }
    await sequelize.query('ALTER TABLE core.companies NO FORCE ROW LEVEL SECURITY');
    await sequelize.query('ALTER TABLE core.roles NO FORCE ROW LEVEL SECURITY');
    try {
      await sequelize.query(
        `INSERT INTO core.role_permissions (id, role_id, permission_id, created_at, updated_at)
         SELECT gen_random_uuid(), r.id, p.id, now(), now()
         FROM core.roles r CROSS JOIN core.permissions p
         WHERE r.name = 'ADMIN' AND p.code IN ('integration:read', 'integration:manage')
           AND NOT EXISTS (SELECT 1 FROM core.role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = p.id)`
      );
    } finally {
      await sequelize.query('ALTER TABLE core.companies FORCE ROW LEVEL SECURITY');
      await sequelize.query('ALTER TABLE core.roles FORCE ROW LEVEL SECURITY');
    }
  },
  down: async () => {},
};
