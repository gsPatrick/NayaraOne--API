'use strict';

/** Constantes de agentes versionados (M9-D004). Nada aqui é regra variável: os limites e as chaves de configuração é que são. */
const STATUSES = Object.freeze(['DRAFT', 'HOMOLOGATED', 'ACTIVE', 'RETIRED']);
const CRITICALITIES = Object.freeze(['CRITICAL', 'NON_CRITICAL']);
const RISK_LEVELS = Object.freeze(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
const HIGH_RISK = Object.freeze(['HIGH', 'CRITICAL']);

const CODE_RE = /^[A-Z][A-Z0-9_]{2,59}$/;
const TOOL_NAME_RE = /^[a-z][a-z0-9_.]{1,99}$/;
const SCOPE_RE = /^[a-z][a-z0-9_.]{1,80}$/;

/**
 * Limites por versão (coluna `limits`): chave do JSON -> parâmetro da empresa que serve de padrão, nome no objeto de limites
 * e faixa aceita. O valor da versão vence o parâmetro; o parâmetro vence nada (o padrão do CSV é o valor inicial).
 */
const LIMIT_SPECS = Object.freeze({
  max_tool_calls_por_run: { setting: 'ia.agente.max_tool_calls_por_run', field: 'maxToolCallsPorRun', fallback: 5, min: 1, max: 50 },
  max_runs_por_minuto_usuario: { setting: 'ia.agente.max_runs_por_minuto_usuario', field: 'maxRunsPorMinutoUsuario', fallback: 10, min: 1, max: 600 },
  timeout_ms: { setting: 'ia.agente.timeout_ms', field: 'timeoutMs', fallback: 30000, min: 1000, max: 300000 },
  max_tokens_run: { setting: 'ia.agente.max_tokens_run', field: 'maxTokensRun', fallback: 8000, min: 100, max: 1000000 },
});

module.exports = { STATUSES, CRITICALITIES, RISK_LEVELS, HIGH_RISK, CODE_RE, TOOL_NAME_RE, SCOPE_RE, LIMIT_SPECS };
