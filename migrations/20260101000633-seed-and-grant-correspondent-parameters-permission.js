'use strict';

const { randomUUID } = require('crypto');

/**
 * Migration: permissão "correspondent:parameters" (Marco 8 — parâmetros do correspondente) + concessão ao ADMIN. Mesmo
 * padrão já usado em 20260101000337 (correspondent:create/read) e PADRAO_COMPONENTES_E_REGRAS.md
 * §2.5 — sem isso, nenhum usuário consegue usar os endpoints fiscais mesmo com o código correto.
 */
const CODE = 'correspondent:parameters';
const DESCRIPTION = 'Configurar parâmetros do Correspondente Bancário: elegibilidade de providers/produtos/finalidades/valores e percentuais de comissão (split corretor/gerente).';
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
    try {
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
    } finally {
      await sequelize.query('ALTER TABLE core.companies FORCE ROW LEVEL SECURITY');
      await sequelize.query('ALTER TABLE core.roles FORCE ROW LEVEL SECURITY');
    }
  },

  down: async () => {
    // Concessão/catálogo de permissão não é revertido automaticamente.
  },
};
