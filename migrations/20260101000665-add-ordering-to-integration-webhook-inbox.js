'use strict';

/**
 * Marco 9, M9-D212 — ordem dos eventos do fornecedor na caixa de entrada (integration.webhook_inbox):
 *  - resource_ref: o recurso do fornecedor a que o evento se refere (id do recurso); internal_status: o status já normalizado pelo adapter;
 *  - status_rank: a posição do status na ordem declarada pelo adapter (PAID 3, PROCESSING 2);
 *  - applied: o evento foi aplicado ao domínio? FALSE = chegou fora de ordem (rank menor que o já aplicado): fica no histórico e o domínio não regride.
 * São colunas de andamento do worker; o conteúdo do evento (hash, corpo) segue como estava. Índice parcial para a conferência por recurso.
 */
module.exports = {
  up: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q('ALTER TABLE "integration"."webhook_inbox" ADD COLUMN IF NOT EXISTS resource_ref varchar(160);');
    await q('ALTER TABLE "integration"."webhook_inbox" ADD COLUMN IF NOT EXISTS internal_status varchar(48);');
    await q('ALTER TABLE "integration"."webhook_inbox" ADD COLUMN IF NOT EXISTS status_rank integer;');
    await q('ALTER TABLE "integration"."webhook_inbox" ADD COLUMN IF NOT EXISTS applied boolean;');
    await q(`CREATE INDEX IF NOT EXISTS webhook_inbox_resource_idx ON "integration"."webhook_inbox" (company_id, provider_code, resource_ref)
             WHERE resource_ref IS NOT NULL AND applied IS TRUE;`);
  },

  down: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q('DROP INDEX IF EXISTS "integration".webhook_inbox_resource_idx;');
    await q('ALTER TABLE "integration"."webhook_inbox" DROP COLUMN IF EXISTS applied;');
    await q('ALTER TABLE "integration"."webhook_inbox" DROP COLUMN IF EXISTS status_rank;');
    await q('ALTER TABLE "integration"."webhook_inbox" DROP COLUMN IF EXISTS internal_status;');
    await q('ALTER TABLE "integration"."webhook_inbox" DROP COLUMN IF EXISTS resource_ref;');
  },
};
