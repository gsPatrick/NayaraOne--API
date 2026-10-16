'use strict';

/**
 * GAP REAL CORRIGIDO (auditoria complementar Nayara, Marcos 4/5, 14/10/2026 — matriz de
 * cobertura "Ledger append-only e estorno (FIN-003/010) — Não comprovado integralmente:
 * UPDATE/DELETE direto bloqueados por banco"): até esta migration, a imutabilidade do ledger
 * financeiro (FIN-003: lançamento liquidado/revertido nunca muda de valor; estorno é sempre um
 * NOVO lançamento compensatório, nunca uma reescrita) era garantida só na camada de serviço
 * (`financialEntries.service.js#updateFinancialEntry` recusa editar lançamento fora de PENDING).
 * Um UPDATE ou DELETE direto via SQL cru (bypassando o serviço) não encontrava nenhuma barreira
 * no banco — `nayara_runtime` mantém privilégio UPDATE/DELETE na tabela (necessário para o
 * próprio fluxo normal: agendar PENDING, liquidar, estornar). Esta migration adiciona um
 * trigger de banco que é a garantia real e independente da aplicação:
 *
 *  - DELETE: sempre bloqueado. O ledger nunca perde uma linha — nem para limpeza de dado de
 *    teste (os testes deste projeto sempre rodam em transação com ROLLBACK, nunca commitam).
 *  - UPDATE: bloqueia qualquer mudança nos campos que definem O FATO financeiro já ocorrido —
 *    group_id, company_id, entry_type, nature, amount, due_at, idempotency_key,
 *    reversal_of_entry_id, created_at, created_by — em QUALQUER status. Mudar qualquer um
 *    desses depois de criado reescreveria história. Os únicos campos que o fluxo normal de
 *    fato precisa mutar depois da criação são: status, settled_at, lock_version, updated_by,
 *    updated_at, bank_account_id e as três dimensões gerenciais enquanto PENDING
 *    (cost_center_id, result_center_id, contract_id).
 *
 *    CORREÇÃO (16/10/2026, achada pela própria regressão desta sessão): bank_account_id tinha
 *    entrado na lista de imutáveis por engano. Existe um fluxo de negócio real e testado
 *    (FIN-REDIR-01/02 em finance.bankAccountRedirect.test.js, ADV-F16 em adversarial.finance)
 *    que troca o banco de um lançamento PENDING antes da liquidação, com revisão/auditoria —
 *    redirectBankAccount em financialEntries.service.js já restringe isso a status=PENDING e
 *    audita a mudança. O trigger não duplica essa regra de status (mesma lógica já aplicada às
 *    três dimensões gerenciais), só protege o fato financeiro em si — e bank_account_id, assim
 *    como as dimensões, NÃO é parte do fato já ocorrido enquanto o lançamento ainda não foi
 *    liquidado.
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
];

const FUNCTION_NAME = 'finance.enforce_financial_entries_append_only';
const TRIGGER_NAME = 'trg_financial_entries_append_only';

function buildFunctionSql() {
  const comparisons = IMMUTABLE_COLUMNS.map(
    (col) => `IF NEW."${col}" IS DISTINCT FROM OLD."${col}" THEN
      RAISE EXCEPTION 'finance.financial_entries é append-only (FIN-003/010): a coluna "%" não pode ser alterada após a criação do lançamento (id=%).', '${col}', OLD.id
        USING ERRCODE = '23514';
    END IF;`
  ).join('\n    ');

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
    await queryInterface.sequelize.query(buildFunctionSql());
    await queryInterface.sequelize.query(`
      DROP TRIGGER IF EXISTS ${TRIGGER_NAME} ON "finance"."financial_entries";
      CREATE TRIGGER ${TRIGGER_NAME}
        BEFORE UPDATE OR DELETE ON "finance"."financial_entries"
        FOR EACH ROW
        EXECUTE FUNCTION ${FUNCTION_NAME}();
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`DROP TRIGGER IF EXISTS ${TRIGGER_NAME} ON "finance"."financial_entries";`);
    await queryInterface.sequelize.query(`DROP FUNCTION IF EXISTS ${FUNCTION_NAME}();`);
  },
};
