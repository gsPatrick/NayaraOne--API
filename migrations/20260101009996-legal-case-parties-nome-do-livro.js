'use strict';

/**
 * Matriz M5 (Caderno §4 "legal.case_parties | Partes do processo"; M5-D102 nome literal do livro, sem visão de
 * compatibilidade): legal.legal_case_parties -> legal.case_parties. RLS, políticas, índices, restrições e GRANTs
 * acompanham o RENAME (são do objeto, não do nome). Reversível.
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(`DO $r$ BEGIN
        IF to_regclass('legal.legal_case_parties') IS NOT NULL AND to_regclass('legal.case_parties') IS NULL THEN
          ALTER TABLE legal.legal_case_parties RENAME TO case_parties;
        END IF;
      END $r$`);
      await q('ALTER TABLE legal.case_parties FORCE ROW LEVEL SECURITY');
      await q(`DO $g$ BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') THEN
          GRANT SELECT, INSERT, UPDATE ON legal.case_parties TO nayara_runtime;
        END IF;
      END $g$`);
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`DO $r$ BEGIN
      IF to_regclass('legal.case_parties') IS NOT NULL AND to_regclass('legal.legal_case_parties') IS NULL THEN
        ALTER TABLE legal.case_parties RENAME TO legal_case_parties;
      END IF;
    END $r$`);
  },
};
