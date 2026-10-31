'use strict';

/**
 * M9-D920 §3.2 — people.files.classification passa a ser OBRIGATÓRIA e a escala do livro (LOW, MEDIUM, HIGH, RESTRICTED), com padrão HIGH (conservador).
 * Arquivos que já existem: PUBLIC -> LOW, INTERNAL -> MEDIUM, CONFIDENTIAL -> HIGH, RESTRICTED -> RESTRICTED; sem classificação (nula) -> HIGH; o arquivo que é documento
 * RESTRICTED do Correspondente (correspondent.case_documents) fica RESTRICTED. Quem tem governance:classification:manage ajusta depois. Os gatilhos de imutabilidade e a RLS
 * FORCE são suspensos só durante a conversão (mesmo padrão da migration 858). O `down` volta ao vocabulário antigo e à coluna opcional (a nulidade original não se recupera).
 */
const NEW_SCALE = "'LOW', 'MEDIUM', 'HIGH', 'RESTRICTED'";
const OLD_SCALE = "'PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED'";
const MAP = "CASE classification WHEN 'PUBLIC' THEN 'LOW' WHEN 'INTERNAL' THEN 'MEDIUM' WHEN 'CONFIDENTIAL' THEN 'HIGH' WHEN 'RESTRICTED' THEN 'RESTRICTED' WHEN 'LOW' THEN 'LOW' WHEN 'MEDIUM' THEN 'MEDIUM' WHEN 'HIGH' THEN 'HIGH' ELSE 'HIGH' END";
const REVERSE = "CASE classification WHEN 'LOW' THEN 'PUBLIC' WHEN 'MEDIUM' THEN 'INTERNAL' WHEN 'HIGH' THEN 'CONFIDENTIAL' ELSE classification END";
const REF = 'people.files';

async function withoutGuards(q, work) {
  const [[state]] = await q(`SELECT relforcerowsecurity AS forced FROM pg_class WHERE oid = '${REF}'::regclass`);
  await q(`ALTER TABLE ${REF} DISABLE TRIGGER USER`);
  if (state.forced) await q(`ALTER TABLE ${REF} NO FORCE ROW LEVEL SECURITY`);
  try { await work(); } finally {
    if (state.forced) await q(`ALTER TABLE ${REF} FORCE ROW LEVEL SECURITY`);
    await q(`ALTER TABLE ${REF} ENABLE TRIGGER USER`);
  }
}

module.exports = {
  MAP,
  REVERSE,
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q('ALTER TABLE people.files DROP CONSTRAINT IF EXISTS files_classification_chk');
      await withoutGuards(q, async () => {
        await q(`UPDATE ${REF} SET classification = ${MAP} WHERE classification IS NOT NULL`);
        await q(`UPDATE ${REF} SET classification = 'HIGH' WHERE classification IS NULL`);
        await q(`UPDATE ${REF} f SET classification = 'RESTRICTED' WHERE f.classification <> 'RESTRICTED'
                  AND EXISTS (SELECT 1 FROM correspondent.case_documents d WHERE d.file_id = f.id AND d.classification = 'RESTRICTED')`);
      });
      await q(`ALTER TABLE ${REF} ADD CONSTRAINT files_classification_chk CHECK (classification IN (${NEW_SCALE}))`);
      await q(`ALTER TABLE ${REF} ALTER COLUMN classification SET DEFAULT 'HIGH'`);
      await q(`ALTER TABLE ${REF} ALTER COLUMN classification SET NOT NULL`);
    });
  },
  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(`ALTER TABLE ${REF} DROP CONSTRAINT IF EXISTS files_classification_chk`);
      await q(`ALTER TABLE ${REF} ALTER COLUMN classification DROP NOT NULL`);
      await q(`ALTER TABLE ${REF} ALTER COLUMN classification DROP DEFAULT`);
      await withoutGuards(q, async () => {
        await q(`UPDATE ${REF} SET classification = ${REVERSE} WHERE classification IS NOT NULL`);
      });
      await q(`ALTER TABLE ${REF} ADD CONSTRAINT files_classification_chk CHECK (classification IS NULL OR classification IN (${OLD_SCALE}))`);
    });
  },
};
