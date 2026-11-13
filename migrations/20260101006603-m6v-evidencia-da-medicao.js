'use strict';

/**
 * Verificação independente do Marco 6 (M6-21). Guia do Marcelo §6: "approveMeasurement(): lockForUpdate → REVIEWED →
 * evidências → permissão → APPROVED → outbox measurement.approved"; Caderno §7: "não sobrescrever evidência/quantidade
 * silenciosamente".
 *  - construction.stage_measurements.evidence_file_ids: as evidências da medição (arquivos do módulo de arquivos da
 *    mesma empresa, examinados pelo antivírus). Mudam só por revisão nova (a medição não tem UPDATE de conteúdo).
 *  - CHECK: medição PAYABLE sempre aponta para a conta a pagar (nenhuma medição a pagar sem obrigação no Financeiro).
 *
 * Dados antigos (ensaio do deploy com o backup da homologação, 13/11/2026): havia medição PAYABLE de antes do vínculo
 * payable_financial_entry_id. Antes da CHECK, a medição recebe o vínculo com a conta a pagar que o fluxo antigo criou (mesma
 * empresa, chave de idempotência `measurement.payable:<id>`, a mesma que o consumidor do Financeiro procura). A CHECK nasce NOT VALID
 * (vale para toda linha nova ou alterada) e é VALIDADA na hora quando não sobra medição antiga sem conta — banco novo fica igual a
 * antes. Se sobrar, a constraint fica sem validar, a migration diz quantas no log e a consulta para listá-las está em
 * docs/DEPLOY_FECHAMENTO_MARCOS_3_A_6.md: decidir caso a caso (gerar a conta a pagar ou reverter a medição) e então
 * `ALTER TABLE construction.stage_measurements VALIDATE CONSTRAINT stage_measurements_payable_has_entry`.
 *
 * O dono das tabelas não tem BYPASSRLS na homologação: as tabelas lidas ficam sem FORCE só durante a carga, na mesma transação
 * (mesmo padrão das migrations 9966 e 10940). Uma transação só: se algo falhar, nada muda. Reversível.
 */
const TABELAS = ['construction.stage_measurements', 'finance.financial_entries'];

async function forcadas(q) {
  const [linhas] = await q(`SELECT n.nspname || '.' || c.relname AS tabela, c.relforcerowsecurity AS forcada
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE (n.nspname || '.' || c.relname) IN (:tabelas)`, { tabelas: TABELAS });
  return linhas.filter((l) => l.forcada).map((l) => l.tabela);
}

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql, replacements) => queryInterface.sequelize.query(sql, { transaction, replacements });
      await q("ALTER TABLE construction.stage_measurements ADD COLUMN IF NOT EXISTS evidence_file_ids uuid[] NOT NULL DEFAULT '{}'::uuid[]");
      const forcar = await forcadas(q);
      for (const t of forcar) await q(`ALTER TABLE ${t} NO FORCE ROW LEVEL SECURITY`);

      const [[antes]] = await q("SELECT count(*)::int AS n FROM construction.stage_measurements WHERE status = 'PAYABLE' AND payable_financial_entry_id IS NULL");
      await q(`UPDATE construction.stage_measurements m SET payable_financial_entry_id = e.id
                 FROM finance.financial_entries e
                WHERE m.status = 'PAYABLE' AND m.payable_financial_entry_id IS NULL
                  AND e.company_id = m.company_id AND e.idempotency_key = 'measurement.payable:' || m.id::text`);
      const [[depois]] = await q("SELECT count(*)::int AS n FROM construction.stage_measurements WHERE status = 'PAYABLE' AND payable_financial_entry_id IS NULL");

      const [[existe]] = await q("SELECT count(*)::int AS n FROM pg_constraint WHERE conname = 'stage_measurements_payable_has_entry'");
      if (!existe.n) {
        await q(`ALTER TABLE construction.stage_measurements ADD CONSTRAINT stage_measurements_payable_has_entry
                   CHECK (status <> 'PAYABLE' OR payable_financial_entry_id IS NOT NULL) NOT VALID`);
      }
      if (depois.n === 0) await q('ALTER TABLE construction.stage_measurements VALIDATE CONSTRAINT stage_measurements_payable_has_entry');
      for (const t of forcar) await q(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`);
      console.log(`[20260101006603] medições PAYABLE sem conta: ${antes.n} antes, ${antes.n - depois.n} ligadas à conta do fluxo antigo, ${depois.n} sem conta`
        + (depois.n ? ' — CHECK criada sem validar (ver docs/DEPLOY_FECHAMENTO_MARCOS_3_A_6.md).' : ' — CHECK validada.'));
    });
  },

  async down(queryInterface) {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q('ALTER TABLE construction.stage_measurements DROP CONSTRAINT IF EXISTS stage_measurements_payable_has_entry');
    await q('ALTER TABLE construction.stage_measurements DROP COLUMN IF EXISTS evidence_file_ids');
  },
};
