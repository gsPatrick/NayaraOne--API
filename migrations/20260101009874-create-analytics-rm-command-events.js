'use strict';

/**
 * Marco 9, demanda M9-D710 (Centro de Comando, bloco 1 "o que aconteceu"): analytics.rm_command_events, uma linha por FATO do dia
 * (contrato assinado, oportunidade ganha, pagamento liquidado). Só ids e agregados: nome, documento e descrição nunca entram. Colunas:
 *   kind            CONTRACT_SIGNED, OPPORTUNITY_WON ou PAYMENT_SETTLED
 *   source_type/id  o registro de origem (Contract, Opportunity, FinancialEntry) para o link respeitando permissão
 *   revision        0 = fato original; 1 = linha compensatória; único (kind, source_id, revision), então reverter duas vezes é impossível
 *   is_reversal     verdadeiro só na revision 1, com amount negado e count_effect -1
 *   occurred_at     instante do fato (assinatura, fechamento, liquidação); a compensatória herda o da original para a soma da janela dar zero
 *   occurred_date   dia de calendário de São Paulo (M9-D606) do occurred_at
 *   amount          valor em BRL (nulo = sem valor: contrato sem total, oportunidade sem proposta aceita)
 *   is_third_party  dinheiro de terceiros (nunca soma ao próprio); broker_id corretor da oportunidade; account_id conta bancária do pagamento
 *   contract_type / origin  dimensões de contrato e de oportunidade
 *   source_event_id evento do outbox que gerou o fato (determinístico: o primeiro do registro), de modo que rebuild e incremental têm o mesmo hash
 *   id              chave estável derivada de (empresa, kind, source_id, revision)
 * RLS ENABLE + FORCE e GRANT ao nayara_runtime com guarda de existência (apoio _helpers/analyticsReadModelTables). Idempotente. Faixa reservada: 9874 a 9881.
 */
const { createReadModelTable, grantRuntime, dropTables } = require('./_helpers/analyticsReadModelTables');

const TABLE = {
  name: 'rm_command_events',
  key: ['kind', 'source_id', 'revision'],
  columns: [
    "id uuid GENERATED ALWAYS AS (md5(company_id::text || '|' || kind || '|' || source_id::text || '|' || revision::text)::uuid) STORED",
    "kind varchar(32) NOT NULL CHECK (kind IN ('CONTRACT_SIGNED', 'OPPORTUNITY_WON', 'PAYMENT_SETTLED'))",
    'source_type varchar(32) NOT NULL', 'source_id uuid NOT NULL',
    'revision smallint NOT NULL DEFAULT 0 CHECK (revision IN (0, 1))',
    'is_reversal boolean NOT NULL DEFAULT false', 'occurred_at timestamptz', 'occurred_date date', 'amount numeric(20,2)',
    'is_third_party boolean NOT NULL DEFAULT false', 'broker_id uuid', 'source_event_id uuid',
    'contract_type varchar(32)', 'origin varchar(64)', 'account_id uuid',
    'count_effect smallint NOT NULL DEFAULT 1 CHECK (count_effect IN (-1, 1))',
    'CONSTRAINT rm_command_events_reversal_ck CHECK (is_reversal = (revision = 1) AND (is_reversal = (count_effect = -1)))',
  ],
};

module.exports = {
  up: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q('CREATE SCHEMA IF NOT EXISTS "analytics"');
    await createReadModelTable(q, TABLE);
    await q('CREATE UNIQUE INDEX IF NOT EXISTS rm_command_events_id_uq ON "analytics"."rm_command_events" (id)');
    await q('CREATE INDEX IF NOT EXISTS rm_command_events_window_idx ON "analytics"."rm_command_events" (company_id, kind, occurred_at)');
    await grantRuntime(q, [TABLE.name]);
  },

  down: async (queryInterface) => dropTables((sql) => queryInterface.sequelize.query(sql), [TABLE.name]),
};
