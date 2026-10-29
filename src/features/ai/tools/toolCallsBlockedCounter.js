'use strict';

/**
 * M9-D681 / M9-D695 — contador nayaraone_api_ai_tool_calls_blocked_total. É incrementado no mesmo ponto em que a linha de ai.tool_calls vira
 * BLOCKED (gravador de chamadas e fechamento STALE da proposta), com o blocked_reason gravado como rótulo: assim o contador e o KPI
 * ai.tool_calls_blocked contam as mesmas recusas, com os mesmos códigos de motivo.
 */
const client = require('prom-client');
const { register } = require('../../../utils/metrics');

const NAME = 'nayaraone_api_ai_tool_calls_blocked_total';
const blocked = register.getSingleMetric(NAME)
  || new client.Counter({ name: NAME, help: 'Chamadas de ferramenta da NAY bloqueadas (ai.tool_calls_blocked)', labelNames: ['reason'], registers: [register] });

const countBlocked = (reason) => blocked.inc({ reason: String(reason || 'UNKNOWN') });

module.exports = { countBlocked, TOOL_CALLS_BLOCKED_COUNTER: NAME };
