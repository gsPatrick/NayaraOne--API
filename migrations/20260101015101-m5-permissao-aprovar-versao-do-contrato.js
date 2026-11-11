'use strict';

const { randomUUID } = require('crypto');

/**
 * Marco 5, Guia §6 approveVersion: assertPermission(ctx, 'contracts.version.approve'). DEC-073 ("Livro"): o nome do livro, sem
 * mapa para legal:approve; os perfis que já tinham legal:approve recebem contracts.version.approve (e o ADMIN de cada empresa).
 * A rota POST /contract-versions/:id/approve e a transição para APPROVED passam a exigir esta permissão. Reversível: o down tira
 * a permissão do catálogo e dos papéis (legal:approve fica como estava).
 */
const CODE = 'contracts.version.approve';

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql, opts = {}) => sequelize.query(sql, { transaction, ...opts });
      await queryInterface.bulkInsert(
        { tableName: 'permissions', schema: 'core' },
        [{ id: randomUUID(), code: CODE, description: 'Aprovar a versão do contrato (Guia M5 §6): homologa a versão vigente com o hash conferido.', risk_level: 'HIGH', created_at: new Date(), updated_at: new Date() }],
        { ignoreDuplicates: true, transaction }
      );
      await q('ALTER TABLE core.companies NO FORCE ROW LEVEL SECURITY');
      await q('ALTER TABLE core.roles NO FORCE ROW LEVEL SECURITY');
      await q(`INSERT INTO core.role_permissions (id, role_id, permission_id, created_at, updated_at)
        SELECT gen_random_uuid(), rp.role_id, pnew.id, now(), now()
          FROM core.role_permissions rp
          JOIN core.permissions pold ON pold.id = rp.permission_id AND pold.code = 'legal:approve'
          CROSS JOIN core.permissions pnew
         WHERE pnew.code = :code
           AND NOT EXISTS (SELECT 1 FROM core.role_permissions x WHERE x.role_id = rp.role_id AND x.permission_id = pnew.id)`, { replacements: { code: CODE } });
      await q(`INSERT INTO core.role_permissions (id, role_id, permission_id, created_at, updated_at)
        SELECT gen_random_uuid(), r.id, p.id, now(), now() FROM core.roles r CROSS JOIN core.permissions p
         WHERE r.name = 'ADMIN' AND p.code = :code
           AND NOT EXISTS (SELECT 1 FROM core.role_permissions x WHERE x.role_id = r.id AND x.permission_id = p.id)`, { replacements: { code: CODE } });
      await q('ALTER TABLE core.companies FORCE ROW LEVEL SECURITY');
      await q('ALTER TABLE core.roles FORCE ROW LEVEL SECURITY');
    });
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql, opts = {}) => sequelize.query(sql, { transaction, ...opts });
      await q('DELETE FROM core.role_permissions WHERE permission_id IN (SELECT id FROM core.permissions WHERE code = :code)', { replacements: { code: CODE } });
      await q('DELETE FROM core.permissions WHERE code = :code', { replacements: { code: CODE } });
    });
  },
};
