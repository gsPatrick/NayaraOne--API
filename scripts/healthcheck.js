'use strict';

/**
 * HEALTHCHECK do contêiner (Dockerfile; rodada 8 da verificação do Marco 9, DI-M9R-23): pede `GET <prefixo>/health/pool` ao próprio processo e sai
 * com 0 quando a resposta é 200, ou 1 em qualquer outro caso (503, sem resposta, prazo). O Docker marca o contêiner como `unhealthy` depois de
 * `--retries` falhas seguidas, e o Easypanel (Docker Swarm) troca o contêiner. Sem dependência: só o `http` do Node, que já está na imagem.
 * Variáveis: PORT (padrão 3000), APP_API_PREFIX (padrão /api), HEALTHCHECK_TIMEOUT_MS (padrão 8.000; deve ficar abaixo do --timeout do Dockerfile).
 */
const http = require('node:http');

const porta = Number(process.env.PORT) || 3000;
const prefixo = process.env.APP_API_PREFIX || '/api';
const prazo = Number(process.env.HEALTHCHECK_TIMEOUT_MS) > 0 ? Number(process.env.HEALTHCHECK_TIMEOUT_MS) : 8000;

const pedido = http.get({ host: '127.0.0.1', port: porta, path: `${prefixo}/health/pool`, timeout: prazo }, (res) => {
  res.resume();
  res.on('end', () => process.exit(res.statusCode === 200 ? 0 : 1));
});
pedido.on('timeout', () => { pedido.destroy(); process.exit(1); });
pedido.on('error', () => process.exit(1));
