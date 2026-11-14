'use strict';

/**
 * Conferência ao vivo do Marco 4 (20/10/2026), F-09: uma linha de extrato com data 2026-10-20 aparecia
 * como 19/10/2026. O CSV trazia só a data; ela era gravada à meia-noite UTC, que em São Paulo é
 * 21:00 do dia anterior (e também jogava as linhas do 1º dia do mês para o mês anterior no
 * fechamento). O serviço agora grava data de dia ao meio-dia de São Paulo (15:00 UTC).
 *
 * Esta migration corrige as linhas JÁ importadas pelo mesmo defeito: só as que estão exatamente à
 * meia-noite UTC (assinatura de data de dia sem hora) recebem +15 horas, o que mantém o dia
 * de calendário que veio no arquivo. Idempotente: depois de corrigidas, deixam de bater no filtro.
 */
module.exports = {
  async up(queryInterface) {
    const [, meta] = await queryInterface.sequelize.query(`
      UPDATE finance.bank_transactions
         SET transaction_date = transaction_date + interval '15 hours'
       WHERE (transaction_date AT TIME ZONE 'UTC')::time = '00:00:00';
    `);
    // eslint-disable-next-line no-console
    console.log(`[migration 601] linhas de extrato com data de dia corrigidas: ${meta && meta.rowCount !== undefined ? meta.rowCount : 'n/d'}`);
  },

  async down() {
    // Sem volta: não há como saber quais linhas foram corrigidas sem uma coluna de marca.
  },
};
