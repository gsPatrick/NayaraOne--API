'use strict';

/**
 * Caderno M4 §17 "Conciliação manual recorrente -> Alerta gerencial" (fechamento do Marco 4,
 * 10/11/2026). Para contar só as conciliações MANUAIS, cada conciliação passa a guardar como foi
 * feita (match_method):
 *   MANUAL               pessoa informou o par (POST /finance/reconciliations e /group);
 *   MANUAL_CHOICE        pessoa escolheu o lançamento na confirmação (POST /finance/reconciliation/:id/confirm com financialEntryId);
 *   SUGGESTION_CONFIRMED pessoa confirmou a sugestão Exato/Forte do motor sem escolher;
 *   AUTO_EXACT / AUTO_STRONG conciliação automática do motor (auto-reconcile).
 * Linhas anteriores ficam MANUAL (todo o fluxo antigo, salvo o auto-reconcile, era manual; a
 * janela do alerta é curta). Coluna com DEFAULT: nenhuma linha é reescrita além do valor padrão.
 */
const METHODS = ['MANUAL', 'MANUAL_CHOICE', 'SUGGESTION_CONFIRMED', 'AUTO_EXACT', 'AUTO_STRONG'];

async function runtimeRoleExists(queryInterface) {
  const [[{ exists }]] = await queryInterface.sequelize.query("SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') AS exists;");
  return exists;
}

module.exports = {
  async up(queryInterface) {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q("ALTER TABLE finance.reconciliations ADD COLUMN IF NOT EXISTS match_method varchar(30) NOT NULL DEFAULT 'MANUAL'");
    await q(`DO $$ BEGIN
               IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reconciliations_match_method_chk') THEN
                 ALTER TABLE finance.reconciliations ADD CONSTRAINT reconciliations_match_method_chk
                   CHECK (match_method IN (${METHODS.map((m) => `'${m}'`).join(', ')}));
               END IF;
             END $$`);
    await q('CREATE INDEX IF NOT EXISTS reconciliations_company_method_matched_idx ON finance.reconciliations (company_id, match_method, matched_at)');
    if (await runtimeRoleExists(queryInterface)) {
      await q('GRANT SELECT, INSERT ON finance.reconciliations TO nayara_runtime');
    }
  },

  async down(queryInterface) {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q('DROP INDEX IF EXISTS finance.reconciliations_company_method_matched_idx');
    await q('ALTER TABLE finance.reconciliations DROP CONSTRAINT IF EXISTS reconciliations_match_method_chk');
    await q('ALTER TABLE finance.reconciliations DROP COLUMN IF EXISTS match_method');
  },
};
