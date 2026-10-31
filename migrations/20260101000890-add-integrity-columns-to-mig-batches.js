'use strict';

/**
 * M9-D905 — governance.mig_batches ganha as raízes Merkle (`source_root` do que foi lido, `target_root` do que foi relido no destino), as contagens correspondentes e o instante
 * da verificação (`verified_at`). `root_hash` (M9-D900) passa a ser a raiz Merkle da origem. Reversível.
 */
module.exports = {
  async up(queryInterface) {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q('ALTER TABLE governance.mig_batches ADD COLUMN IF NOT EXISTS source_root char(64) NULL');
    await q('ALTER TABLE governance.mig_batches ADD COLUMN IF NOT EXISTS target_root char(64) NULL');
    await q('ALTER TABLE governance.mig_batches ADD COLUMN IF NOT EXISTS source_count integer NULL');
    await q('ALTER TABLE governance.mig_batches ADD COLUMN IF NOT EXISTS target_count integer NULL');
    await q('ALTER TABLE governance.mig_batches ADD COLUMN IF NOT EXISTS verified_at timestamptz NULL');
  },
  async down(queryInterface) {
    const q = (sql) => queryInterface.sequelize.query(sql);
    for (const column of ['verified_at', 'target_count', 'source_count', 'target_root', 'source_root']) {
       
      await q(`ALTER TABLE governance.mig_batches DROP COLUMN IF EXISTS ${column}`);
    }
  },
};
