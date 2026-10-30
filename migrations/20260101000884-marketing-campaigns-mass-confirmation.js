'use strict';

/**
 * M9-D433 — confirmação do disparo em massa. Acima do limite sem aprovação, quem agenda precisa de `marketing:send:mass` e essa permissão É a confirmação explícita (sem segunda
 * tela). A campanha guarda quem confirmou e quando, para o disparo de cada step provar a confirmação sem depender do agendador estar logado. Só colunas novas e nulas.
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(
      'ALTER TABLE marketing.campaigns ADD COLUMN IF NOT EXISTS mass_confirmed_by uuid NULL, ADD COLUMN IF NOT EXISTS mass_confirmed_at timestamptz NULL'
    );
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('ALTER TABLE marketing.campaigns DROP COLUMN IF EXISTS mass_confirmed_at, DROP COLUMN IF EXISTS mass_confirmed_by');
  },
};
