'use strict';

/**
 * M4LR (verificação independente do Marco 4, 11/11/2026) — Caderno M4 §7 "Ledger DDL mínimo", §6 "Financial entry x
 * Ledger", §5 "finance.bank_transactions — extrato importado imutável" e FIN-004/FIN-008.
 *
 * O ledger é a view finance.ledger sobre finance.financial_entries (migration 560). Esta migration faz o DDL do livro
 * valer no banco:
 *   - idempotency_key NOT NULL (varchar 180): sem chave do cliente, o banco grava `lancamento:<id>`; a baixa integral
 *     grava a chave do MOVIMENTO em settlement_idempotency_key (a view expõe COALESCE das duas), única por empresa;
 *   - created_by NOT NULL: sem autor, o usuário do contexto (app.user_id) ou o ator de sistema (automação);
 *   - CHECK amount > 0 (nenhuma linha de 0,00); conta bancária obrigatória no movimento confirmado pelo banco (Guia §7);
 *   - source_event_id na view (o evento de domínio do movimento), movement_kind (PARTIAL/COMPLEMENT/EXCESS/REVERSAL);
 *   - finance.bank_transactions imutável para o papel de runtime (gatilho; DELETE/UPDATE revogados).
 *
 * Dados existentes (antes das constraints, cada correção numa linha de finance.ledger_m4lr_migration_log e no
 * audit.audit_log; contagem antes/depois por empresa). Nada é apagado:
 *   1. movement_kind das filhas/estornos antigos (excedente reconhecido pela chave `:excedente` ou pelo texto);
 *   2. chave nula -> `legado:<id>`; autor nulo -> quem a auditoria registrou (criação, baixa parcial ou estorno),
 *      senão updated_by, senão o ator de sistema;
 *   3. valor <= 0 (vinha do "1e-3" gravado como 0,00): fica na tabela com ledger_exclusion_reason (fora do ledger,
 *      sem dinheiro); o previsto de 0,00 em aberto é cancelado;
 *   4. estorno lançado sobre previsto NUNCA realizado (sonda P2): não é movimento — sai do ledger pelo mesmo motivo;
 *   5. estorno do valor cheio de um pai com baixas parciais (sonda P3): sai do ledger e cada baixa filha ainda de pé
 *      ganha o REVERSAL correto, no período corrente (Caderno §16 "ajuste posterior entra no período corrente");
 *   6. status do pai recalculado pelo ledger (sonda P4: pai SETTLED com baixa estornada volta a PARTIALLY_SETTLED).
 * O down desfaz tudo pelo log (inclusive os estornos de correção criados no passo 5).
 */
const { up: upData, down: downData } = require('../ledger-ddl-m4lr.data');

module.exports = {
  async up(queryInterface) {
    await upData(queryInterface);
    await queryInterface.sequelize.query(
      "COMMENT ON TABLE finance.ledger_m4lr_migration_log IS 'Migration 20260101010520 (M4LR): contagem antes/depois por empresa e cada correção de dado feita antes das constraints do ledger (Caderno M4 §7).'"
    );
  },
  async down(queryInterface) {
    await downData(queryInterface);
  },
};
