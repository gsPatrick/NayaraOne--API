'use strict';

/**
 * Marco 9, M9-D215 — motivo da fila morta do envio e índice da reconciliação:
 *  - integration.dispatches.dead_letter_reason: por que o envio foi para DEAD_LETTER. UNKNOWN_UNRESOLVED = esgotou as consultas ao
 *    fornecedor sem descobrir se a operação aconteceu (revisão humana no extrato); ATTEMPTS_EXHAUSTED = esgotou as tentativas de envio.
 *    Fica preenchido só enquanto o envio está em DEAD_LETTER (o retry humano o limpa; a auditoria guarda o histórico);
 *  - dispatches_unknown_due_idx: a rodada da reconciliação lê só os envios em UNKNOWN, pela data da próxima consulta.
 * São colunas de andamento: o gatilho de imutabilidade da D205 continua protegendo só o conteúdo aprovado.
 */
const MOTIVOS = ['UNKNOWN_UNRESOLVED', 'ATTEMPTS_EXHAUSTED'];

module.exports = {
  up: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q('ALTER TABLE "integration"."dispatches" ADD COLUMN IF NOT EXISTS dead_letter_reason varchar(64);');
    await q(`DO $c$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dispatches_dead_letter_reason_chk') THEN
        ALTER TABLE "integration"."dispatches" ADD CONSTRAINT dispatches_dead_letter_reason_chk
          CHECK (dead_letter_reason IS NULL OR dead_letter_reason IN (${MOTIVOS.map((m) => `'${m}'`).join(', ')}));
      END IF;
    END $c$;`);
    await q(`CREATE INDEX IF NOT EXISTS dispatches_unknown_due_idx ON "integration"."dispatches" (company_id, next_attempt_at) WHERE status = 'UNKNOWN';`);
  },

  down: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q('DROP INDEX IF EXISTS "integration".dispatches_unknown_due_idx;');
    await q('ALTER TABLE "integration"."dispatches" DROP CONSTRAINT IF EXISTS dispatches_dead_letter_reason_chk;');
    await q('ALTER TABLE "integration"."dispatches" DROP COLUMN IF EXISTS dead_letter_reason;');
  },
};
