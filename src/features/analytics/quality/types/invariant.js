'use strict';

/**
 * M9-D696 (3.1 item 6) — INVARIANT / CONSISTENCY: regra de negócio que tem de valer sempre (recebíveis 7d <= 30d <= 60d; caixa livre + terceiros =
 * caixa total; percentual entre 0 e 100). `evaluate(ctx)` devolve { ok, expected, observed }. Falha = BLOCK por padrão. Sem linha para
 * conferir (read model vazio) devolve ok.
 */
function build(type, severityKey) {
  return ({ code, metrics = [], evaluate }) => ({
    code, type, metrics,
    async run(ctx) {
      const { ok, expected, observed } = await evaluate(ctx);
      return ok ? { passed: true, expected, observed } : { passed: false, severityKey, expected, observed };
    },
  });
}

module.exports = { invariant: build('INVARIANT', 'INVARIANT'), consistency: build('CONSISTENCY', 'CONSISTENCY') };
