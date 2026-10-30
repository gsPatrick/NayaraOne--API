'use strict';

/**
 * M9-D910 §3.2.5 — converte o vocabulário antigo de classificação das três tabelas que o código já grava para a escala do livro, sem perda e de forma reversível:
 * PUBLIC -> LOW, INTERNAL -> MEDIUM, CONFIDENTIAL -> HIGH, RESTRICTED -> RESTRICTED. O valor antigo fica em `legacy_classification`; valor desconhecido vira HIGH e entra
 * em governance.classification_review_items. Tabelas: ai.knowledge_entries (padrão INTERNAL -> MEDIUM), real_estate.property_media (PUBLIC -> LOW) e
 * correspondent.case_documents (padrão RESTRICTED). Os gatilhos de imutabilidade e a RLS FORCE são suspensos só durante a conversão (padrão das migrations 248 e 633).
 * `integration.outbox_events.classification` (TRANSIENT, VALIDATION, CONFLICT) é classificação de FALHA e não entra. Reversível: o `down` devolve o valor antigo.
 */
const TABLES = [
  { ref: 'ai.knowledge_entries', constraint: 'knowledge_classification_chk', nullable: false, defaultValue: 'MEDIUM', oldDefault: 'INTERNAL' },
  { ref: 'real_estate.property_media', constraint: 'property_media_classification_chk', nullable: true, defaultValue: null, oldDefault: null },
  { ref: 'correspondent.case_documents', constraint: 'case_documents_classification_check', nullable: false, defaultValue: 'RESTRICTED', oldDefault: 'RESTRICTED' },
];
const NEW_SCALE = "'LOW', 'MEDIUM', 'HIGH', 'RESTRICTED'";
const MAP = "CASE classification WHEN 'PUBLIC' THEN 'LOW' WHEN 'INTERNAL' THEN 'MEDIUM' WHEN 'CONFIDENTIAL' THEN 'HIGH' WHEN 'RESTRICTED' THEN 'RESTRICTED' WHEN 'LOW' THEN 'LOW' WHEN 'MEDIUM' THEN 'MEDIUM' WHEN 'HIGH' THEN 'HIGH' ELSE 'HIGH' END";
const REVERSE = "CASE classification WHEN 'LOW' THEN 'PUBLIC' WHEN 'MEDIUM' THEN 'INTERNAL' WHEN 'HIGH' THEN 'CONFIDENTIAL' ELSE classification END";

async function withoutGuards(q, ref, work) {
  const [[state]] = await q(`SELECT relforcerowsecurity AS forced FROM pg_class WHERE oid = '${ref}'::regclass`);
  await q(`ALTER TABLE ${ref} DISABLE TRIGGER USER`);
  if (state.forced) await q(`ALTER TABLE ${ref} NO FORCE ROW LEVEL SECURITY`);
  try { await work(); } finally {
    if (state.forced) await q(`ALTER TABLE ${ref} FORCE ROW LEVEL SECURITY`);
    await q(`ALTER TABLE ${ref} ENABLE TRIGGER USER`);
  }
}

module.exports = {
  MAP,
  REVERSE,
  TABLES,
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      for (const t of TABLES) {
        await q(`ALTER TABLE ${t.ref} ADD COLUMN IF NOT EXISTS legacy_classification varchar(60) NULL`);
        await q(`ALTER TABLE ${t.ref} DROP CONSTRAINT IF EXISTS ${t.constraint}`); // a regra antiga recusaria o valor novo na conversão
        await withoutGuards(q, t.ref, async () => {
          // Valor antigo desconhecido: fica na lista de revisão (convertido para HIGH).
          await q(`INSERT INTO governance.classification_review_items (group_id, company_id, table_ref, record_id, legacy_value, converted_value)
                   SELECT group_id, company_id, '${t.ref}', id, classification, 'HIGH' FROM ${t.ref}
                    WHERE classification IS NOT NULL AND classification NOT IN ('PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED', ${NEW_SCALE}) ON CONFLICT DO NOTHING`);
          await q(`UPDATE ${t.ref} SET legacy_classification = classification, classification = ${MAP}
                    WHERE classification IS NOT NULL AND legacy_classification IS NULL`);
        });
        await q(`ALTER TABLE ${t.ref} ADD CONSTRAINT ${t.constraint} CHECK (classification IS NULL OR classification IN (${NEW_SCALE}))`);
        if (t.defaultValue) await q(`ALTER TABLE ${t.ref} ALTER COLUMN classification SET DEFAULT '${t.defaultValue}'`);
      }
    });
  },
  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      for (const t of TABLES) {
        await q(`ALTER TABLE ${t.ref} DROP CONSTRAINT IF EXISTS ${t.constraint}`);
        await withoutGuards(q, t.ref, async () => {
          await q(`UPDATE ${t.ref} SET classification = COALESCE(legacy_classification, ${REVERSE}) WHERE classification IS NOT NULL`);
        });
        await q(`ALTER TABLE ${t.ref} DROP COLUMN IF EXISTS legacy_classification`);
        if (t.oldDefault) await q(`ALTER TABLE ${t.ref} ALTER COLUMN classification SET DEFAULT '${t.oldDefault}'`);
        const check = t.ref === 'correspondent.case_documents' ? "'RESTRICTED', 'INTERNAL', 'PUBLIC'" : "'PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED'";
        if (t.ref !== 'real_estate.property_media') await q(`ALTER TABLE ${t.ref} ADD CONSTRAINT ${t.constraint} CHECK (classification IN (${check}))`);
      }
      await q("DELETE FROM governance.classification_review_items WHERE table_ref IN ('ai.knowledge_entries', 'real_estate.property_media', 'correspondent.case_documents')");
    });
  },
};
