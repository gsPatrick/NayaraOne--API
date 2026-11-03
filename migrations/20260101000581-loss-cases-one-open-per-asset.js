'use strict';

/**
 * Revisão Marco 7 (19/10/2026), item A4: o mesmo patrimônio podia ter vários casos de perda
 * abertos ao mesmo tempo (cobrança em dobro do responsável). O serviço passa a recusar, e este
 * índice único parcial fecha a regra no banco para qualquer caminho de escrita: no máximo UM
 * caso não decidido (OPEN ou PENDING_APPROVAL) por patrimônio.
 *
 * Se já houver duplicidade no banco, a migration falha listando os patrimônios — decidir os
 * casos repetidos é decisão humana (nunca apagamos/fechamos caso de perda automaticamente).
 */
module.exports = {
  async up(queryInterface) {
    const q = (sql) => queryInterface.sequelize.query(sql);
    const [dups] = await q(`SELECT asset_id, count(*)::int AS n FROM inventory.loss_cases
                             WHERE asset_id IS NOT NULL AND status IN ('OPEN','PENDING_APPROVAL')
                             GROUP BY asset_id HAVING count(*) > 1`);
    if (dups.length > 0) {
      throw new Error(`Há patrimônios com mais de um caso de perda aberto — decida-os antes: ${dups.map((d) => `${d.asset_id} (${d.n})`).join(', ')}`);
    }
    await q(`CREATE UNIQUE INDEX IF NOT EXISTS loss_cases_one_open_per_asset
               ON inventory.loss_cases (asset_id)
               WHERE asset_id IS NOT NULL AND status IN ('OPEN','PENDING_APPROVAL')`);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP INDEX IF EXISTS inventory.loss_cases_one_open_per_asset');
  },
};
