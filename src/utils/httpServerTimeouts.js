'use strict';

/**
 * Tempos do servidor HTTP (verificação independente do Marco 9, rodada 7, 12/11/2026; DI-M9R-19).
 *
 * O Node fecha a conexão keep-alive ociosa em 5 s (`keepAliveTimeout`). Quem reaproveita a conexão logo depois desse prazo (um proxy ou balanceador
 * na frente da API, ou um cliente que ficou um instante sem pedir) escreve numa conexão que o servidor acabou de fechar: o pedido sai sem resposta
 * (ECONNRESET; atrás de um proxy, 502). Na sonda da rodada 7 isso aconteceu num pedido depois de uma pausa de 6,7 s. O prazo passa a 65 s, acima do
 * prazo de ociosidade dos balanceadores comuns (60 s), e o prazo dos cabeçalhos fica 1 s acima dele, como o Node recomenda.
 * Variável de ambiente `HTTP_KEEP_ALIVE_TIMEOUT_MS` (padrão 65.000; faixa 1.000 a 600.000): limite do servidor, não da empresa.
 *
 * Método CONNECT (túnel de proxy): o Node não passa o pedido ao Express e, sem quem o atenda, só fecha a conexão (o cliente fica sem resposta).
 * A API não é proxy: responde como a qualquer outro método sem rota (TRACE, PROPFIND ...), 404 `ROUTE_NOT_FOUND` no formato único de erro, com o
 * código de suporte (M9-D852), e fecha.
 */
const PADRAO = 65000;
const FAIXA = [1000, 600000];

function keepAliveDoAmbiente(env = process.env) {
  const n = Number(env.HTTP_KEEP_ALIVE_TIMEOUT_MS);
  return env.HTTP_KEEP_ALIVE_TIMEOUT_MS !== undefined && Number.isInteger(n) && n >= FAIXA[0] && n <= FAIXA[1] ? n : PADRAO;
}

/** Responde 404 ROUTE_NOT_FOUND ao CONNECT e fecha a conexão (nunca lança). */
function recusarConnect(_req, socket) {
  try {
    const traceId = require('node:crypto').randomUUID();
    const corpo = JSON.stringify({ success: false, error: { code: 'ROUTE_NOT_FOUND', message: 'Rota não encontrada.', traceId } });
    socket.end(`HTTP/1.1 404 Not Found\r\nContent-Type: application/json; charset=utf-8\r\nX-Correlation-Id: ${traceId}\r\nContent-Length: ${Buffer.byteLength(corpo)}\r\nConnection: close\r\n\r\n${corpo}`);
  } catch (_e) {
    try { socket.destroy(); } catch (_e2) { /* nada mais a fazer */ }
  }
}

/** Aplica os tempos ao servidor recém-criado (`app.listen`) e a resposta ao CONNECT. Devolve o servidor. */
function aplicarTemposDoServidor(server, env = process.env) {
  const keepAlive = keepAliveDoAmbiente(env);
  server.keepAliveTimeout = keepAlive;
  server.headersTimeout = keepAlive + 1000;
  if (typeof server.on === 'function') server.on('connect', recusarConnect);
  return server;
}

module.exports = { aplicarTemposDoServidor, keepAliveDoAmbiente, recusarConnect, PADRAO };
