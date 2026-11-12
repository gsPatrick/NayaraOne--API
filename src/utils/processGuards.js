'use strict';

const { erroParaLog } = require('../middlewares/errorHandler.safe');

/**
 * Proteção do processo da API (verificação independente do Marco 9, rodada 7, 12/11/2026; DI-M9R-19).
 *
 * Sem ela, uma promessa rejeitada sem tratamento (no Node 15 ou mais novo) ou uma exceção que escapa de um callback encerra o processo: a API para
 * para TODAS as empresas por causa de um pedido. Foi o que aconteceu com o `PUT /settings/:key` de `value` aninhado (o errorHandler assíncrono
 * rejeitou ao montar a resposta). O errorHandler agora não lança; esta proteção é a segunda barreira:
 * - `unhandledRejection`: registra como ERRO, com a pilha, e a API segue atendendo;
 * - `uncaughtException`: registra como FATAL, com a pilha e a origem, e a API segue atendendo. Cada pedido do Express tem estado próprio e as
 *   transações do banco são por pedido; o registro fatal é o sinal para a equipe investigar a causa, que precisa ser corrigida no código.
 * Instalada uma vez só, depois das conferências do boot (falha de configuração no boot continua encerrando o processo, como deve).
 */
let instalada = false;

function installProcessGuards({ log, proc = process } = {}) {
  if (instalada) return false;
  instalada = true;
  proc.on('unhandledRejection', (motivo) => {
    try { log.error({ code: 'PROCESS_UNHANDLED_REJECTION', err: erroParaLog(motivo) }, '[Processo] promessa rejeitada sem tratamento; a API continua atendendo'); } catch (_e) { /* o registro não derruba */ }
  });
  proc.on('uncaughtException', (err, origem) => {
    try { log.fatal({ code: 'PROCESS_UNCAUGHT_EXCEPTION', origin: String(origem || ''), err: erroParaLog(err) }, '[Processo] exceção sem tratamento; a API continua atendendo'); } catch (_e) { /* o registro não derruba */ }
  });
  return true;
}

module.exports = { installProcessGuards };
