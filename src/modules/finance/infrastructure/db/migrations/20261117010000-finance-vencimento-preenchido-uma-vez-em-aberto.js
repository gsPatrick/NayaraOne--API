'use strict';

/**
 * Segunda leva (16/11/2026, DI-BI2-6): o vencimento passa a ser obrigatório no lançamento próprio a pagar ou a receber (Caderno M4 §19,
 * contas e recebíveis 7/30/60 e inadimplência). O trigger append-only (migrations 366/382) trata `due_at` como fato imutável, o que
 * impedia dois caminhos que a regra nova precisa:
 *  - o excedente de um recebimento nasce PENDING_CLASSIFICATION SEM vencimento e, classificado como despesa, vira conta a pagar própria
 *    em aberto: o vencimento informado na classificação precisa ser gravado;
 *  - o lançamento em aberto antigo que ficou sem vencimento precisa poder recebê-lo pela edição.
 *
 * Exceção estreita, como a de `nature` para PENDING_CLASSIFICATION: `due_at` pode ir de NULO para uma data UMA vez, enquanto o lançamento
 * está PENDING. Trocar uma data gravada por outra, apagá-la ou preenchê-la depois de liquidado continua recusado pelo banco. Todas as
 * demais colunas e regras da migration 382 ficam como estavam.
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

function guardOf(col, dueAtFillable) {
  if (col === 'nature') {
    return `IF NEW."${col}" IS DISTINCT FROM OLD."${col}" AND NOT (OLD."${col}" = 'PENDING_CLASSIFICATION' AND OLD."status" = 'PENDING') THEN`;
  }
  if (col === 'due_at' && dueAtFillable) {
    return `IF NEW."${col}" IS DISTINCT FROM OLD."${col}" AND NOT (OLD."${col}" IS NULL AND NEW."${col}" IS NOT NULL AND OLD."status" = 'PENDING') THEN`;
  }
  return `IF NEW."${col}" IS DISTINCT FROM OLD."${col}" THEN`;
}

function buildFunctionSql(dueAtFillable) {
  const comparisons = IMMUTABLE_COLUMNS.map((col) => `${guardOf(col, dueAtFillable)}
      RAISE EXCEPTION 'finance.financial_entries é append-only (FIN-003/010): a coluna "%" não pode ser alterada após a criação do lançamento (id=%).', '${col}', OLD.id
        USING ERRCODE = '23514';
    END IF;`).join('\n    ');

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
    await queryInterface.sequelize.query(buildFunctionSql(true));
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(buildFunctionSql(false));
  },
};
