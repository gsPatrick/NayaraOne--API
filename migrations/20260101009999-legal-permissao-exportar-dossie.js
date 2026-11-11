'use strict';

const { randomUUID } = require('crypto');

/**
 * Caderno M5 §19 "Exportar dossiê | Permissão específica + audit/MFA conforme risco" e JUR-TS-011 "Export sem
 * permissão | Dossiê | Negado": permissão própria `legal:evidence:export` no catálogo, concedida ao papel ADMIN
 * (mesmo padrão de legal:waive, migration 460). A exportação deixa de valer para qualquer `legal:read`; a DLP
 * (finalidade, justificativa, MFA e auditoria conforme a classe) continua valendo por cima. Reversível.
 */
const CODE = 'legal:evidence:export';

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    const now = new Date();
    await queryInterface.bulkInsert(
      { tableName: 'permissions', schema: 'core' },
      [{ id: randomUUID(), code: CODE, description: 'Exportar dossiê de provas do Jurídico (com auditoria e MFA conforme a classe dos anexos).', risk_level: 'HIGH', created_at: now, updated_at: now }],
      { ignoreDuplicates: true }
    );
    await sequelize.query('ALTER TABLE core.companies NO FORCE ROW LEVEL SECURITY');
    await sequelize.query('ALTER TABLE core.roles NO FORCE ROW LEVEL SECURITY');
    try {
      await sequelize.query(`
        INSERT INTO core.role_permissions (id, role_id, permission_id, created_at, updated_at)
        SELECT gen_random_uuid(), r.id, p.id, now(), now()
        FROM core.roles r CROSS JOIN core.permissions p
        WHERE r.name = 'ADMIN' AND p.code = :code
          AND NOT EXISTS (SELECT 1 FROM core.role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = p.id)
      `, { replacements: { code: CODE } });
    } finally {
      await sequelize.query('ALTER TABLE core.companies FORCE ROW LEVEL SECURITY');
      await sequelize.query('ALTER TABLE core.roles FORCE ROW LEVEL SECURITY');
    }
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.query('DELETE FROM core.role_permissions WHERE permission_id IN (SELECT id FROM core.permissions WHERE code = :code)', { replacements: { code: CODE } });
    await sequelize.query('DELETE FROM core.permissions WHERE code = :code', { replacements: { code: CODE } });
  },
};
