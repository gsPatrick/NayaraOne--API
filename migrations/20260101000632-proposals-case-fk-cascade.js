'use strict';

/** proposals acompanha o caso como os demais filhos do caso (documentos, simulações, histórico): apagar o caso apaga as propostas dele. */
module.exports = {
  up: async (queryInterface) => {
    const q = queryInterface.sequelize;
    await q.query('ALTER TABLE "correspondent"."proposals" DROP CONSTRAINT IF EXISTS proposals_financing_case_id_fkey;');
    await q.query(`ALTER TABLE "correspondent"."proposals" ADD CONSTRAINT proposals_financing_case_id_fkey
      FOREIGN KEY (financing_case_id) REFERENCES "correspondent"."financing_cases"(id) ON DELETE CASCADE ON UPDATE CASCADE;`);
  },
  down: async (queryInterface) => {
    const q = queryInterface.sequelize;
    await q.query('ALTER TABLE "correspondent"."proposals" DROP CONSTRAINT IF EXISTS proposals_financing_case_id_fkey;');
    await q.query(`ALTER TABLE "correspondent"."proposals" ADD CONSTRAINT proposals_financing_case_id_fkey
      FOREIGN KEY (financing_case_id) REFERENCES "correspondent"."financing_cases"(id) ON DELETE RESTRICT ON UPDATE CASCADE;`);
  },
};
