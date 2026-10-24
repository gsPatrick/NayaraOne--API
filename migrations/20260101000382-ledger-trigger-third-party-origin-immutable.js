'use strict';

/**
 * F04 (conferência Nayara 18/10/2026): o vínculo de uma devolução/compensação de caução com o
 * recebimento de origem (third_party_origin_entry_id) e o titular do dinheiro
 * (third_party_holder_person_id) eram gravados só na criação, mas a imutabilidade dependia da
 * aplicação. Reescrever qualquer um dos dois depois trocaria a caução que a saída consumiu —
 * exatamente a rastreabilidade que o §13 exige. Esta migration recria a função do trigger
 * append-only (migration 366) acrescentando as duas colunas à lista de imutáveis, sem mudar
 * nenhuma regra existente (inclusive a exceção estreita de "nature" para PENDING_CLASSIFICATION).
 */

const IMMUTABLE_COLUMNS = [
  'group_id',
  'company_id',
  'entry_type',
  'nature',
  'amount',
  'due_at',
  'idempotency_key',
  'reversal_of_entry_id',
  'created_at',
  'created_by',
  'third_party_origin_entry_id',
  'third_party_holder_person_id',
];

const FUNCTION_NAME = 'finance.enforce_financial_entries_append_only';

function buildFunctionSql(columns) {
  const comparisons = columns.map((col) => {
    const guard =
      col === 'nature'
        ? `IF NEW."${col}" IS DISTINCT FROM OLD."${col}" AND NOT (OLD."${col}" = 'PENDING_CLASSIFICATION' AND OLD."status" = 'PENDING') THEN`
        : `IF NEW."${col}" IS DISTINCT FROM OLD."${col}" THEN`;
    return `${guard}
      RAISE EXCEPTION 'finance.financial_entries é append-only (FIN-003/010): a coluna "%" não pode ser alterada após a criação do lançamento (id=%).', '${col}', OLD.id
        USING ERRCODE = '23514';
    END IF;`;
  }).join('\n    ');

  return `
    CREATE OR REPLACE FUNCTION ${FUNCTION_NAME}()
    RETURNS TRIGGER AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'finance.financial_entries é append-only (FIN-003/010): DELETE direto não é permitido (id=%). Use reverseFinancialEntry para estornar.', OLD.id
          USING ERRCODE = '23514';
      END IF;

      IF TG_OP = 'UPDATE' THEN
        ${comparisons}
      END IF;

      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `;
}

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(buildFunctionSql(IMMUTABLE_COLUMNS));
  },

  async down(queryInterface) {
    const previous = IMMUTABLE_COLUMNS.filter(
      (col) => col !== 'third_party_origin_entry_id' && col !== 'third_party_holder_person_id'
    );
    await queryInterface.sequelize.query(buildFunctionSql(previous));
  },
};
