'use strict';

const { randomUUID } = require('crypto');

/**
 * Marco 9, M9-D244 3.3 item 4 — as rotas administrativas de integração têm permissões separadas: integration:read,
 * integration:manage, integration:retry e integration:test (testar conexão, M9-D250). As três primeiras já existem
 * (migrations 651 e 656); esta cria integration:test e a concede ao ADMIN. Mesmo padrão de 651.
 */
const DESCRICAO = 'Testar a conexão de uma integração da empresa (chamada de teste ao fornecedor), sem alterar a conexão.';

module.exports = {
  up: async (queryInterface) => {
    const sequelize = queryInterface.sequelize;
    await sequelize.query(
      `INSERT INTO core.permissions (id, code, description, risk_level, created_at, updated_at)
       SELECT :id, 'integration:test', :description, 'MEDIUM', now(), now()
       WHERE NOT EXISTS (SELECT 1 FROM core.permissions WHERE code = 'integration:test')`,
      { replacements: { id: randomUUID(), description: DESCRICAO } }
    );
    await sequelize.query('ALTER TABLE core.companies NO FORCE ROW LEVEL SECURITY');
    await sequelize.query('ALTER TABLE core.roles NO FORCE ROW LEVEL SECURITY');
    try {
      await sequelize.query(
        `INSERT INTO core.role_permissions (id, role_id, permission_id, created_at, updated_at)
         SELECT gen_random_uuid(), r.id, p.id, now(), now()
         FROM core.roles r CROSS JOIN core.permissions p
         WHERE r.name = 'ADMIN' AND p.code = 'integration:test'
           AND NOT EXISTS (SELECT 1 FROM core.role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = p.id)`
      );
    } finally {
      await sequelize.query('ALTER TABLE core.companies FORCE ROW LEVEL SECURITY');
      await sequelize.query('ALTER TABLE core.roles FORCE ROW LEVEL SECURITY');
    }
  },
  down: async () => {},
};
