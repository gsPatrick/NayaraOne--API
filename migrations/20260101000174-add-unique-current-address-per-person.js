'use strict';

/**
 * Constraint única PARCIAL: no máximo 1 "people"."person_addresses" com is_current=true por
 * person_id.
 *
 * DECISÃO DE ENGENHARIA — achado real na auditoria adversarial (23/09/2026): createAddress
 * fazia um UPDATE em massa (isCurrent=false WHERE personId=X AND isCurrent=true) seguido de um
 * INSERT incondicional do endereço novo (isCurrent=true). Isso não protege contra concorrência
 * real: se já existe uma linha "atual", o UPDATE trava essa linha e serializa as duas
 * transações — mas cada uma ainda faz seu PRÓPRIO INSERT depois, então as duas acabam
 * inserindo um endereço "atual" (a segunda simplesmente não encontra mais nada pra desmarcar).
 * Se NÃO existe nenhuma linha atual ainda (primeiro endereço da pessoa), não há nem o que
 * travar — duas criações concorrentes inserem duas linhas isCurrent=true direto. Nenhuma
 * combinação de SELECT/UPDATE em memória fecha essa corrida; só uma constraint no banco
 * garante de verdade "no máximo 1 atual por pessoa" sob concorrência real.
 */
module.exports = {
  up: async (queryInterface) => {
    await queryInterface.sequelize.query(`
      CREATE UNIQUE INDEX person_addresses_one_current_per_person_uk
      ON "people"."person_addresses" (person_id)
      WHERE is_current = true;
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP INDEX IF EXISTS "people"."person_addresses_one_current_per_person_uk";');
  },
};
