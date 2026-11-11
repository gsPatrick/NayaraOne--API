'use strict';

const { randomUUID } = require('crypto');

/**
 * Fechamento M5 — Entrega de chaves (Caderno M5 §10 "Assinatura do termo de entrega"; Guia §11
 * assertPermission(ctx, 'lease.keys.deliver')):
 *  - legal.key_deliveries.term_evidence_file_id: a via do termo assinada pelo recebedor (evidência da assinatura),
 *    term_signature_method (MANUAL_EVIDENCE) e term_evidence_sha256 (hash do arquivo no momento da assinatura);
 *  - permissão do livro `lease.keys.deliver` no catálogo, concedida a todo papel que já tinha legal:deliverKeys
 *    (o nome antigo continua no catálogo só como histórico; as rotas checam o nome do livro).
 * Reversível.
 */
const CODE = 'lease.keys.deliver';

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql, opts = {}) => sequelize.query(sql, { transaction, ...opts });
      await q(`ALTER TABLE legal.key_deliveries
        ADD COLUMN IF NOT EXISTS term_evidence_file_id uuid NULL REFERENCES people.files(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        ADD COLUMN IF NOT EXISTS term_evidence_sha256 varchar(64) NULL,
        ADD COLUMN IF NOT EXISTS term_signature_method varchar(24) NULL`);
      await queryInterface.bulkInsert(
        { tableName: 'permissions', schema: 'core' },
        [{ id: randomUUID(), code: CODE, description: 'Entregar as chaves do imóvel (liberação da entrega de chaves, Guia M5 §11).', risk_level: 'HIGH', created_at: new Date(), updated_at: new Date() }],
        { ignoreDuplicates: true, transaction }
      );
      await q('ALTER TABLE core.companies NO FORCE ROW LEVEL SECURITY');
      await q('ALTER TABLE core.roles NO FORCE ROW LEVEL SECURITY');
      await q(`INSERT INTO core.role_permissions (id, role_id, permission_id, created_at, updated_at)
        SELECT gen_random_uuid(), rp.role_id, pnew.id, now(), now()
          FROM core.role_permissions rp
          JOIN core.permissions pold ON pold.id = rp.permission_id AND pold.code = 'legal:deliverKeys'
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
      await q('ALTER TABLE legal.key_deliveries DROP COLUMN IF EXISTS term_evidence_file_id, DROP COLUMN IF EXISTS term_evidence_sha256, DROP COLUMN IF EXISTS term_signature_method');
    });
  },
};
