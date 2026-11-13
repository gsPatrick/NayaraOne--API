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
 * payable_financial_entry_id. A CHECK nasce NOT VALID (vale para toda linha nova ou alterada) e é VALIDADA aqui quando não há
 * medição antiga sem conta — banco novo fica igual a antes. O vínculo das medições antigas com a conta que o fluxo antigo criou
 * fica na migration do Financeiro 20260101006608 (M4-D140: o que lê finance.* mora na pasta do módulo), que valida a CHECK se não
 * sobrar nenhuma; o que sobrar fica listado em docs/DEPLOY_FECHAMENTO_MARCOS_3_A_6.md para decisão.
 *
 * O dono das tabelas pode não ter BYPASSRLS (padrão das migrations 9966 e 10940): a medição fica sem FORCE só durante a
 * conferência, na mesma transação. Reversível.
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q("ALTER TABLE construction.stage_measurements ADD COLUMN IF NOT EXISTS evidence_file_ids uuid[] NOT NULL DEFAULT '{}'::uuid[]");
      const [[estado]] = await q("SELECT relforcerowsecurity AS forcada FROM pg_class WHERE oid = 'construction.stage_measurements'::regclass");
      if (estado.forcada) await q('ALTER TABLE construction.stage_measurements NO FORCE ROW LEVEL SECURITY');
      const [[existe]] = await q("SELECT count(*)::int AS n FROM pg_constraint WHERE conname = 'stage_measurements_payable_has_entry'");
      if (!existe.n) {
        await q(`ALTER TABLE construction.stage_measurements ADD CONSTRAINT stage_measurements_payable_has_entry
                   CHECK (status <> 'PAYABLE' OR payable_financial_entry_id IS NOT NULL) NOT VALID`);
      }
      const [[sem]] = await q("SELECT count(*)::int AS n FROM construction.stage_measurements WHERE status = 'PAYABLE' AND payable_financial_entry_id IS NULL");
      if (sem.n === 0) await q('ALTER TABLE construction.stage_measurements VALIDATE CONSTRAINT stage_measurements_payable_has_entry');
      if (estado.forcada) await q('ALTER TABLE construction.stage_measurements FORCE ROW LEVEL SECURITY');
      console.log(`[20260101006603] medições PAYABLE sem conta: ${sem.n}` + (sem.n ? ' — CHECK criada sem validar; o vínculo com a conta antiga vem na 20260101006608.' : ' — CHECK validada.'));
    });
  },

  async down(queryInterface) {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q('ALTER TABLE construction.stage_measurements DROP CONSTRAINT IF EXISTS stage_measurements_payable_has_entry');
    await q('ALTER TABLE construction.stage_measurements DROP COLUMN IF EXISTS evidence_file_ids');
  },
};
