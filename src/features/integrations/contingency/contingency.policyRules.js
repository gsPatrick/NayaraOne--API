'use strict';

const { MODES } = require('./contingency.constants');
const { LIMITES, UUID_RE, inRange } = require('./contingency.limits');

/**
 * Regras PURAS da seção `contingency` de uma política (M9-D226 3.1): `mode`, `queue_max_age_h`, `alternate_connection_id`,
 * `manual_task_assignee_role` e `notify_roles`. Usadas ao salvar a política do fornecedor e da connection (422 INTEGRATION_POLICY_INVALID).
 */
const NOME_PAPEL = { min: 2, max: 60 };
const nomeValido = (v) => typeof v === 'string' && v.trim().length >= NOME_PAPEL.min && v.trim().length <= NOME_PAPEL.max;

const CAMPOS = {
  mode: (v) => (MODES.includes(v) ? null : `use um destes: ${MODES.join(', ')}`),
  queue_max_age_h: (v) => (inRange(v, LIMITES.queueMaxAgeH) ? null : `use um inteiro de ${LIMITES.queueMaxAgeH.min} a ${LIMITES.queueMaxAgeH.max}`),
  alternate_connection_id: (v) => (v === null || (typeof v === 'string' && UUID_RE.test(v)) ? null : 'use o identificador (uuid) da integração alternativa'),
  manual_task_assignee_role: (v) => (nomeValido(v) ? null : `use um nome de papel de ${NOME_PAPEL.min} a ${NOME_PAPEL.max} caracteres`),
  notify_roles: (v) => (Array.isArray(v) && v.length >= 1 && v.length <= 10 && v.every(nomeValido) ? null : 'use uma lista de 1 a 10 nomes de papel'),
};

function contingencyProblems(section) {
  if (section === undefined) return [];
  if (section === null || typeof section !== 'object' || Array.isArray(section)) return ['contingency: esperado um objeto'];
  return Object.entries(section).flatMap(([chave, valor]) => {
    if (!CAMPOS[chave]) return [`contingency.${chave}: campo desconhecido`];
    const problema = CAMPOS[chave](valor);
    return problema ? [`contingency.${chave}: ${problema}`] : [];
  });
}

module.exports = { contingencyProblems, CAMPOS_DA_POLITICA: Object.freeze(Object.keys(CAMPOS)) };
