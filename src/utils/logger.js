'use strict';

/**
 * logger — TEC-13 (homologação 10/09/2026): os únicos registros de erro do sistema eram
 * `console.error` de texto livre, sem estrutura — impossível filtrar por severidade,
 * correlationId, rota ou tenant depois do fato, mesmo tendo acesso ao terminal/logs do
 * container. O Easypanel já captura a saída padrão (stdout/stderr) de qualquer jeito — trocar
 * pra JSON estruturado torna esses MESMOS logs já coletados imediatamente pesquisáveis/
 * filtráveis, sem precisar de nenhuma infraestrutura nova.
 *
 * DECISÃO DE ENGENHARIA — não especificado no Caderno: não plugamos um backend de logs
 * externo (Grafana Loki, Better Stack, Datadog etc.) — isso exige contratar/provisionar um
 * serviço à parte, decisão comercial que caberia à cliente. O que dá pra garantir com
 * segurança agora é que TODA saída de log já é estruturada e pronta para qualquer coletor
 * externo ser plugado depois sem precisar mudar uma linha de código de negócio.
 */
const pino = require('pino');

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  base: { service: 'nayaraone-api' },
  timestamp: pino.stdTimeFunctions.isoTime,
});

module.exports = logger;
