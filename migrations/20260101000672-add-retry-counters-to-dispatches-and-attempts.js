'use strict';

/**
 * Marco 9, M9-D216 — contadores da política de nova tentativa por classe de erro:
 *  - integration.dispatches.auth_renewals: quantas vezes a credencial foi renovada para ESTE envio (no máximo 1: a segunda
 *    recusa de credencial pausa a connection);
 *  - integration.dispatch_attempts.rate_limited: a tentativa terminou em limite do fornecedor (429 ou cota). Não conta como falha;
 *    alimenta rate_limit_count da saúde (M9-D206/D218) e o teto de adiamentos seguidos.
 * São colunas de andamento: o gatilho de imutabilidade da D205 continua protegendo só o conteúdo aprovado.
 */
module.exports = {
  up: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q('ALTER TABLE "integration"."dispatches" ADD COLUMN IF NOT EXISTS auth_renewals smallint NOT NULL DEFAULT 0;');
    await q(`DO $c$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dispatches_auth_renewals_chk') THEN
        ALTER TABLE "integration"."dispatches" ADD CONSTRAINT dispatches_auth_renewals_chk CHECK (auth_renewals >= 0 AND auth_renewals <= 5);
      END IF;
    END $c$;`);
    await q('ALTER TABLE "integration"."dispatch_attempts" ADD COLUMN IF NOT EXISTS rate_limited boolean NOT NULL DEFAULT false;');
  },

  down: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q('ALTER TABLE "integration"."dispatch_attempts" DROP COLUMN IF EXISTS rate_limited;');
    await q('ALTER TABLE "integration"."dispatches" DROP CONSTRAINT IF EXISTS dispatches_auth_renewals_chk;');
    await q('ALTER TABLE "integration"."dispatches" DROP COLUMN IF EXISTS auth_renewals;');
  },
};
