'use strict';

/**
 * Tempos máximos das sessões do banco (rodada 8 da verificação do Marco 9, 12/11/2026; DI-M9R-23).
 *
 * Uma transação que ficou aberta sem ninguém para terminá-la (o código que faria o `commit` falhou) segurava a linha travada para sempre, e o pedido
 * seguinte nessa linha ficava sem resposta. O Postgres resolve isso por sessão, com dois parâmetros enviados na abertura de cada conexão do pool:
 * - `idle_in_transaction_session_timeout` (`DB_IDLE_IN_TRANSACTION_TIMEOUT_MS`, padrão 300.000 ms = 5 min): a sessão parada no meio de uma
 *   transação por mais que isso é encerrada pelo banco, que desfaz a transação e solta as travas. O padrão cobre a maior espera legítima dentro de
 *   uma transação hoje: a leitura automática de documento (OCR local, até 60 s por página) roda dentro da transação do pedido;
 * - `statement_timeout` (`DB_STATEMENT_TIMEOUT_MS`, padrão 120.000 ms = 2 min): nenhum comando isolado da API passa disso (as consultas do BI e o
 *   refresh dos read models já usam limites locais menores, que continuam valendo por cima deste).
 * `0` desliga o limite (o comportamento anterior). Valor fora da faixa ou que não é inteiro vale o padrão.
 *
 * As migrations (sequelize-cli) recebem só o limite de transação parada; o `statement_timeout` delas é `DB_MIGRATION_STATEMENT_TIMEOUT_MS`
 * (padrão 0, desligado), porque uma migration pode ter um comando longo legítimo (índice, cópia de dados).
 */
const PADRAO = Object.freeze({ idleInTransactionMs: 300000, statementMs: 120000, migrationStatementMs: 0 });
const FAIXA = Object.freeze([0, 86400000]);

function msDoAmbiente(valor, padrao) {
  const n = Number(valor);
  if (valor === undefined || valor === '' || !Number.isInteger(n) || n < FAIXA[0] || n > FAIXA[1]) return padrao;
  return n;
}

/** Limites em vigor: { idleInTransactionMs, statementMs, migrationStatementMs }. */
function temposDaSessao(env = process.env) {
  return {
    idleInTransactionMs: msDoAmbiente(env.DB_IDLE_IN_TRANSACTION_TIMEOUT_MS, PADRAO.idleInTransactionMs),
    statementMs: msDoAmbiente(env.DB_STATEMENT_TIMEOUT_MS, PADRAO.statementMs),
    migrationStatementMs: msDoAmbiente(env.DB_MIGRATION_STATEMENT_TIMEOUT_MS, PADRAO.migrationStatementMs),
  };
}

/** Opções do driver `pg` (dialectOptions do Sequelize) para as conexões da aplicação ou, com `migracao: true`, das migrations. */
function opcoesDeTempoDaSessao({ migracao = false, env = process.env } = {}) {
  const t = temposDaSessao(env);
  return {
    idle_in_transaction_session_timeout: t.idleInTransactionMs,
    statement_timeout: migracao ? t.migrationStatementMs : t.statementMs,
  };
}

module.exports = { temposDaSessao, opcoesDeTempoDaSessao, PADRAO, FAIXA };
