'use strict';

/**
 * Padrões, limites e formato dos parâmetros dos alertas (M9-D224). Arquivo PURO (sem banco nem configurações), para o dicionário do
 * SETTINGS_SCHEMA e a leitura (alerts.params.js) usarem a mesma faixa sem ciclo de dependência.
 */
const PADROES = Object.freeze({ repeatMin: 60, notifyRoles: 'ADMIN', circuitOpenMin: 5, evaluateIntervalS: 60 });
const LIMITES = Object.freeze({
  repeatMin: { min: 1, max: 10080 },
  circuitOpenMin: { min: 1, max: 1440 },
  evaluateIntervalS: { min: 10, max: 3600 },
  roles: { max: 10, nameMin: 2, nameMax: 60 },
});
const ROLE_RE = /^[\p{L}\p{N} _-]+$/u;

/** Lista de papéis "ADMIN, Diretoria" -> ['ADMIN', 'Diretoria']; null se o formato for inválido. */
function parseRoles(texto) {
  if (typeof texto !== 'string') return null;
  const nomes = texto.split(',').map((x) => x.trim());
  const ok = nomes.length >= 1 && nomes.length <= LIMITES.roles.max
    && nomes.every((n) => n.length >= LIMITES.roles.nameMin && n.length <= LIMITES.roles.nameMax && ROLE_RE.test(n));
  return ok ? [...new Set(nomes)] : null;
}

module.exports = { PADROES, LIMITES, parseRoles };
