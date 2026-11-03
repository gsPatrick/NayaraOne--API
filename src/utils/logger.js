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
  // Nunca registrar credenciais (o log de requisição do pino-http imprimia o JWT completo do
  // header Authorization em cada linha). Vale para qualquer log que carregue req/res/headers.
  redact: {
    paths: [
      // cabeçalhos de requisição e resposta (pino-http registra req.headers e res.headers)
      'req.headers.authorization', 'req.headers.cookie', 'req.headers["proxy-authorization"]',
      'req.headers["x-api-key"]', 'req.headers["x-auth-token"]', 'req.headers["x-refresh-token"]',
      'req.headers["x-csrf-token"]', 'req.headers["x-mfa-code"]', 'req.headers["x-signature"]',
      'res.headers["set-cookie"]', 'res.headers.authorization',
      'headers.authorization', 'headers.cookie', 'headers["set-cookie"]',
      // corpo e query, caso algum log os carregue (nunca devem sair em claro)
      'req.body.password', 'req.body.senha', 'req.body.token', 'req.body.refreshToken',
      'req.body.accessToken', 'req.body.mfaCode', 'req.body.code', 'req.body.secret',
      'req.query.token', 'req.query.access_token', 'req.query.refresh_token',
      'req.query.password', 'req.query.secret', 'req.query.api_key', 'req.query.key',
      // campos sensíveis em qualquer objeto de primeiro nível dos logs de erro
      '*.password', '*.passwordHash', '*.senha', '*.token', '*.accessToken', '*.refreshToken',
      '*.secret', '*.apiKey', '*.mfaCode', '*.authorization', '*.cookie',
    ],
    censor: '[REDACTED]',
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

/**
 * redactUrl — mascara o valor de parâmetros sensíveis na query string de uma URL
 * (?token=…, ?access_token=…, ?password=…), usada nas mensagens e no campo `url` dos logs.
 */
const SENSITIVE_QUERY_KEYS = /^(token|access_token|refresh_token|id_token|password|senha|secret|api_key|apikey|key|code|signature|sig)$/i;
function safeDecode(v) {
  try { return decodeURIComponent(v); } catch (_) { return v; }
}
function redactUrl(url) {
  if (typeof url !== 'string') return url;
  const i = url.indexOf('?');
  if (i < 0) return url;
  const base = url.slice(0, i);
  const query = url.slice(i + 1).split('&').map((pair) => {
    const eq = pair.indexOf('=');
    if (eq < 0) return pair;
    return SENSITIVE_QUERY_KEYS.test(safeDecode(pair.slice(0, eq)).trim()) ? `${pair.slice(0, eq)}=[REDACTED]` : pair;
  }).join('&');
  return `${base}?${query}`;
}

module.exports = logger;
module.exports.redactUrl = redactUrl;
