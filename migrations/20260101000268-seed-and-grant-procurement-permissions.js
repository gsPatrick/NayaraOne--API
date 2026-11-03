'use strict';

const { randomUUID } = require('crypto');

/**
 * Migration: catálogo de permissões "procurement:*" (Marco 7 — Compras) + concessão ao papel
 * ADMIN. Mesmo padrão de 20260101000256 (inventory:*) — concessão explícita desde a primeira
 * migration, evitando pela quarta vez o incidente de "endpoint funciona mas ninguém acessa".
 */
const CODES = [
  ['procurement:create', 'Criar requisição de compra, cotação, oferta de fornecedor, PO e recebimento.', 'MEDIUM'],
  ['procurement:read', 'Consultar requisições, cotações, pedidos de compra e divergências.', 'LOW'],
  ['procurement:approve', 'Aprovar requisição de compra e adjudicar oferta de fornecedor.', 'HIGH'],
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
