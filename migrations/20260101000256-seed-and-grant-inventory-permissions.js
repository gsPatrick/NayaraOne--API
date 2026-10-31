'use strict';

const { randomUUID } = require('crypto');

/**
 * Migration: catálogo de permissões "inventory:*" (Marco 7) + concessão ao papel ADMIN.
 * Mesmo bug de classe já corrigido em 20260101000248 (construction:*) e 20260101000253
 * (finance:*): sem a concessão explícita ao ADMIN, nenhum usuário consegue usar os endpoints
 * mesmo com o código funcionando. Semeando catálogo + concessão juntos nesta migration pra não
 * repetir o mesmo incidente pela terceira vez.
 */
const CODES = [
  ['inventory:create', 'Cadastrar itens, locais, receber NF, criar requisições, empréstimos e OS de manutenção de estoque/patrimônio.', 'MEDIUM'],
  ['inventory:read', 'Consultar itens, saldos, movimentos, ferramentas e patrimônio.', 'LOW'],
  ['inventory:update', 'Editar cadastro de itens, locais e patrimônio.', 'MEDIUM'],
  ['inventory:approve', 'Aprovar ajuste de saldo, baixa de perda/descarte e requisição de material acima da alçada.', 'HIGH'],
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
