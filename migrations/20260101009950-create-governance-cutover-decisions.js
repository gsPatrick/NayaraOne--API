'use strict';

/**
 * M9-D907 (DI-D907-1) — governance.cutover_decisions: a decisão da atividade GO_NO_GO do corte (GO ou NO_GO), com quem decidiu e quando. T0 é o instante da última decisão GO. Só se acrescenta.
 * RLS + FORCE pela função do alicerce; GRANT ao runtime dentro de guarda de existência do papel. Reversível.
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(`CREATE TABLE IF NOT EXISTS governance.cutover_decisions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES core.groups(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        company_id uuid NOT NULL REFERENCES core.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        decision varchar(8) NOT NULL,
        reason text NULL,
        decided_by uuid NULL REFERENCES core.users(id) ON UPDATE CASCADE ON DELETE SET NULL,
        decided_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT cutover_decisions_decision_chk CHECK (decision IN ('GO', 'NO_GO'))
      )`);
      await q('CREATE INDEX IF NOT EXISTS cutover_decisions_company_idx ON governance.cutover_decisions (company_id, decided_at DESC)');
      await q("SELECT governance.apply_tenant_rls('governance.cutover_decisions'::regclass)");
      await q(`DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') THEN
          GRANT SELECT, INSERT, UPDATE, DELETE ON governance.cutover_decisions TO nayara_runtime;
        END IF;
      END $$`);
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS governance.cutover_decisions');
  },
};
