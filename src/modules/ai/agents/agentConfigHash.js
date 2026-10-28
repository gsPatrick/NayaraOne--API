'use strict';

const crypto = require('node:crypto');

/**
 * Hash de configuração da versão (M9-D004): política, modelo, escopos, limites, criticidade e allowlist de tools. Texto
 * canônico (chaves ordenadas) para o mesmo conteúdo dar sempre o mesmo hash. O `global_hash` e a regra de regressão são de
 * M9-D033. Igual a migrations/_helpers/aiAgentsSeed.js (o teste m9d004 confere a paridade).
 */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((acc, key) => { acc[key] = canonical(value[key]); return acc; }, {});
  }
  return value;
}

function computeConfigHash({ code, purpose, systemPolicy, modelPolicy, dataScopes, limits, criticality, tools }) {
  const ferramentas = [...(tools || [])]
    .sort((a, b) => (a.toolName < b.toolName ? -1 : 1))
    .map((t) => ({
      toolName: t.toolName, permissionCode: t.permissionCode, riskLevel: t.riskLevel, requiresHumanApproval: t.requiresHumanApproval, enabled: t.enabled,
    }));
  const texto = JSON.stringify(canonical({
    code, purpose, systemPolicy, modelPolicy, dataScopes, limits, criticality, tools: ferramentas,
  }));
  return crypto.createHash('sha256').update(texto, 'utf8').digest('hex');
}

module.exports = { computeConfigHash };
