'use strict';

/**
 * Conferência ao vivo do Marco 4 (20/10/2026), achado A1: a importação de extrato aceitava
 * "abc" e gravava NaN em finance.bank_transactions.amount — numeric(18,2) aceita 'NaN', e uma
 * só linha assim zerava o saldo bancário e o caixa livre. O serviço agora recusa o lote, e o banco
 * passa a recusar NaN por conta própria.
 *
 * A restrição entra como NOT VALID: vale para toda linha nova e toda alteração, sem falhar por causa
 * de linhas NaN que já existam. Se não houver nenhuma, ela é validada na hora. Se houver, a
 * migration avisa quantas são (NOTICE) e deixa a validação para depois do saneamento.
 */
module.exports = {
  async up(queryInterface) {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
           WHERE conrelid = 'finance.bank_transactions'::regclass AND conname = 'bank_transactions_amount_not_nan'
        ) THEN
          ALTER TABLE finance.bank_transactions
            ADD CONSTRAINT bank_transactions_amount_not_nan CHECK (amount <> 'NaN'::numeric) NOT VALID;
        END IF;
      END $$;
    `);
    const [[{ n }]] = await queryInterface.sequelize.query(
      "SELECT count(*)::int AS n FROM finance.bank_transactions WHERE amount = 'NaN'::numeric;"
    );
    if (n === 0) {
      await q('ALTER TABLE finance.bank_transactions VALIDATE CONSTRAINT bank_transactions_amount_not_nan;');
    } else {
      // eslint-disable-next-line no-console
      console.warn(`[migration 600] ${n} linha(s) de extrato com valor NaN já existem; a restrição vale para novas gravações e fica sem validar até o saneamento.`);
    }
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query('ALTER TABLE finance.bank_transactions DROP CONSTRAINT IF EXISTS bank_transactions_amount_not_nan;');
  },
};
