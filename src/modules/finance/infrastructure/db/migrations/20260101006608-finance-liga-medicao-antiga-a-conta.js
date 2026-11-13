'use strict';

/**
 * Integração dos Marcos 3 a 6 com o Marco 9 (ensaio do deploy com o backup da homologação, 13/11/2026). A 20260101006603 (Marco 6) criou
 * a CHECK stage_measurements_payable_has_entry (medição PAYABLE sempre aponta para a conta a pagar) sem validar quando há medição antiga
 * sem o vínculo. Aqui a medição antiga recebe o vínculo com a conta a pagar que o fluxo anterior criou: mesma empresa, chave de
 * idempotência `measurement.payable:<id>` (a mesma que o consumidor do Financeiro procura, measurement-payable.consumer.js). Se não sobrar
 * medição PAYABLE sem conta, a CHECK é validada; senão a lista fica em docs/DEPLOY_FECHAMENTO_MARCOS_3_A_6.md para decisão (gerar a conta
 * ou reverter a medição) e a validação é feita depois, à mão.
 *
 * O dono das tabelas pode não ter BYPASSRLS (padrão das migrations 9966 e 10940): as duas tabelas ficam sem FORCE só durante a carga,
 * na mesma transação. O down não desfaz o vínculo: ele liga a medição à conta que já era dela (nada é apagado nem inventado).
 */
const TABELAS = ['construction.stage_measurements', 'finance.financial_entries'];

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql, replacements) => queryInterface.sequelize.query(sql, { transaction, replacements });
      const [linhas] = await q(`SELECT n.nspname || '.' || c.relname AS tabela FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE (n.nspname || '.' || c.relname) IN (:tabelas) AND c.relforcerowsecurity`, { tabelas: TABELAS });
      const forcar = linhas.map((l) => l.tabela);
      for (const t of forcar) await q(`ALTER TABLE ${t} NO FORCE ROW LEVEL SECURITY`);
      const [[antes]] = await q("SELECT count(*)::int AS n FROM construction.stage_measurements WHERE status = 'PAYABLE' AND payable_financial_entry_id IS NULL");
      await q(`UPDATE construction.stage_measurements m SET payable_financial_entry_id = e.id
                 FROM finance.financial_entries e
                WHERE m.status = 'PAYABLE' AND m.payable_financial_entry_id IS NULL
                  AND e.company_id = m.company_id AND e.idempotency_key = 'measurement.payable:' || m.id::text`);
      const [[depois]] = await q("SELECT count(*)::int AS n FROM construction.stage_measurements WHERE status = 'PAYABLE' AND payable_financial_entry_id IS NULL");
      const [[valida]] = await q("SELECT convalidated FROM pg_constraint WHERE conname = 'stage_measurements_payable_has_entry'");
      if (valida && !valida.convalidated && depois.n === 0) await q('ALTER TABLE construction.stage_measurements VALIDATE CONSTRAINT stage_measurements_payable_has_entry');
      for (const t of forcar) await q(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`);
      console.log(`[20260101006608] medições PAYABLE sem conta: ${antes.n} antes, ${antes.n - depois.n} ligadas à conta do fluxo antigo, ${depois.n} sem conta`
        + (depois.n ? ' — CHECK continua sem validar (ver docs/DEPLOY_FECHAMENTO_MARCOS_3_A_6.md).' : ' — CHECK validada.'));
    });
  },

  async down() {
    // Nada a desfazer: o vínculo liga a medição à conta que já era dela.
  },
};
