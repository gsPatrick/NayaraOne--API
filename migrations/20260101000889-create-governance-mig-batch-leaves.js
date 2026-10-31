'use strict';

/**
 * M9-D905 — governance.mig_batch_leaves: as folhas da árvore Merkle do lote (única parte da árvore guardada). `leaf_hash_source` é a folha do que foi lido na origem, gravada junto
 * com o lote; `leaf_hash_target` é a do que o verificador releu do banco de destino (nulo antes da verificação ou quando a linha sumiu). Quando as raízes diferem, a comparação
 * folha a folha aponta as linhas divergentes. RLS + FORCE pela função do alicerce. Reversível.
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(`CREATE TABLE IF NOT EXISTS governance.mig_batch_leaves (
        group_id uuid NOT NULL REFERENCES core.groups(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        company_id uuid NOT NULL REFERENCES core.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        batch_id uuid NOT NULL REFERENCES governance.mig_batches(id) ON UPDATE CASCADE ON DELETE CASCADE,
        source_key varchar(128) NOT NULL,
        leaf_hash_source char(64) NOT NULL,
        leaf_hash_target char(64) NULL,
        PRIMARY KEY (batch_id, source_key)
      )`);
      await q("SELECT governance.apply_tenant_rls('governance.mig_batch_leaves'::regclass)");
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS governance.mig_batch_leaves');
  },
};
