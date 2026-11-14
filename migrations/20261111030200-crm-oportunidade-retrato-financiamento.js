'use strict';

/**
 * CAD-09 (Marco 3 §9: "Oportunidade pode vincular financing_case do módulo Correspondente. Status do financiamento atualiza CRM por
 * eventos, sem duplicar dados bancários dentro do CRM"). Retrato do financiamento na oportunidade, escrito SÓ pelo consumidor do
 * evento financing.status.changed / financing.case.created (crm/financingStatus.consumer.js):
 *  - financing_case_id: referência ao caso do Correspondente (FK, ON DELETE SET NULL);
 *  - financing_status: o status normalizado do caso (DRAFT ... COMPLETED/CANCELED);
 *  - financing_status_at: quando o status mudou (o retrato só avança: evento mais antigo não sobrescreve o mais novo).
 * Nada bancário (banco, proposta, valores, taxas, ids externos) entra no CRM. Colunas novas e nulas: nenhuma linha muda; a
 * migration confere a contagem de oportunidades antes e depois (nada some) e a volta remove só as três colunas. O GRANT de
 * UPDATE nas três colunas para o papel da aplicação é repetido com guarda (cobre privilégio por coluna, se houver).
 */
const TABLE = 'crm.opportunities';

async function countRows(sequelize, transaction) {
  const [[row]] = await sequelize.query(`SELECT count(*)::bigint AS n FROM ${TABLE}`, { transaction });
  return String(row.n);
}

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      const before = await countRows(sequelize, transaction);
      await q(`ALTER TABLE ${TABLE}
        ADD COLUMN IF NOT EXISTS financing_case_id uuid NULL REFERENCES correspondent.financing_cases(id) ON UPDATE CASCADE ON DELETE SET NULL,
        ADD COLUMN IF NOT EXISTS financing_status varchar(32) NULL,
        ADD COLUMN IF NOT EXISTS financing_status_at timestamptz NULL`);
      await q(`DO $c$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'opportunities_financing_snapshot_chk') THEN
          ALTER TABLE ${TABLE} ADD CONSTRAINT opportunities_financing_snapshot_chk
            CHECK ((financing_status IS NULL AND financing_status_at IS NULL) OR (financing_status IS NOT NULL AND financing_status_at IS NOT NULL));
        END IF;
      END $c$`);
      await q(`CREATE INDEX IF NOT EXISTS opportunities_financing_case_id_idx ON ${TABLE} (financing_case_id)`);
      await q(`DO $g$ BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') THEN
          GRANT SELECT (financing_case_id, financing_status, financing_status_at), UPDATE (financing_case_id, financing_status, financing_status_at) ON ${TABLE} TO nayara_runtime;
        END IF;
      END $g$`);
      const after = await countRows(sequelize, transaction);
      if (before !== after) throw new Error(`CAD-09: contagem de oportunidades mudou (${before} -> ${after}).`);
      // eslint-disable-next-line no-console
      console.log(`[migration CAD-09] crm.opportunities: ${before} linha(s) antes, ${after} depois; colunas do retrato do financiamento criadas.`);
    });
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const before = await countRows(sequelize, transaction);
      await sequelize.query(`DROP INDEX IF EXISTS crm.opportunities_financing_case_id_idx`, { transaction });
      await sequelize.query(`ALTER TABLE ${TABLE}
        DROP CONSTRAINT IF EXISTS opportunities_financing_snapshot_chk,
        DROP COLUMN IF EXISTS financing_status_at,
        DROP COLUMN IF EXISTS financing_status,
        DROP COLUMN IF EXISTS financing_case_id`, { transaction });
      const after = await countRows(sequelize, transaction);
      if (before !== after) throw new Error(`CAD-09 (volta): contagem de oportunidades mudou (${before} -> ${after}).`);
      // eslint-disable-next-line no-console
      console.log(`[migration CAD-09 volta] crm.opportunities: ${before} linha(s) antes, ${after} depois; colunas do retrato removidas.`);
    });
  },
};
