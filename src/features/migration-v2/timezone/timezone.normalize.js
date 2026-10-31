'use strict';

const { localToUtc, hasExplicitZone, STATUS } = require('./timezone.convert');

const CODES = Object.freeze({
  NONEXISTENT: 'GOV_MIG_TZ_NONEXISTENT_LOCAL_TIME',
  AMBIGUOUS: 'GOV_MIG_TZ_AMBIGUOUS_LOCAL_TIME',
  INVALID: 'GOV_MIG_TZ_INVALID_TIMESTAMP',
});
const MESSAGES = Object.freeze({
  [CODES.NONEXISTENT]: 'O horário informado não existe no fuso de origem.',
  [CODES.AMBIGUOUS]: 'O horário informado ocorre duas vezes no fuso de origem.',
  [CODES.INVALID]: 'O horário informado não é uma data e hora válida.',
});
const CIVIL_DAY = /^(\d{4}-\d{2}-\d{2})(?:$|[ T])/;

/** Campo de data sem hora (M9-D908 §3.2.2): o mesmo dia civil, sem conversão de fuso. `2026-10-31 00:00:00` continua 2026-10-31. Data inválida volta como veio (o destino a recusa). */
function civilDay(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? value : `${String(value.getFullYear()).padStart(4, '0')}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
  const match = typeof value === 'string' ? CIVIL_DAY.exec(value.trim()) : null;
  return match ? match[1] : value;
}

const problem = (code, field) => ({ code, field, reason: `${code}: ${MESSAGES[code]} (campo ${field})` });

/**
 * Instante de um campo de data e hora. Com fuso explícito (Z ou deslocamento) ou já um Date, vale o instante. Sem fuso, é horário local do `zone` (migracao.fuso_origem) e passa
 * pela base IANA: inexistente vai à quarentena; ambíguo segue `ambiguous` (FIRST_OCCURRENCE, SECOND_OCCURRENCE ou QUARANTINE). Devolve { value } ou { problem }.
 */
function instantOf(value, field, { zone, ambiguous }) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? { problem: problem(CODES.INVALID, field) } : { value: value.toISOString() };
  if (typeof value !== 'string') return { value };
  if (hasExplicitZone(value)) {
    const parsed = new Date(value.trim());
    return Number.isNaN(parsed.getTime()) ? { problem: problem(CODES.INVALID, field) } : { value: parsed.toISOString() };
  }
  const result = localToUtc(value, zone);
  if (result.status === STATUS.OK) return { value: result.utc };
  if (result.status === STATUS.NONEXISTENT) return { problem: problem(CODES.NONEXISTENT, field) };
  if (result.status === STATUS.AMBIGUOUS) {
    if (ambiguous === 'QUARANTINE') return { problem: problem(CODES.AMBIGUOUS, field) };
    return { value: ambiguous === 'SECOND_OCCURRENCE' ? result.second : result.first };
  }
  return { problem: problem(CODES.INVALID, field) };
}

/**
 * Normaliza os campos temporais de uma linha canônica pelo esquema da entidade (M9-D908 §3.2): `date` fica no dia civil, `instant` vai para UTC. Devolve { row, verdict }; `verdict`
 * é o veredito de quarentena (mesmo formato do `assess` dos destinos) quando algum horário não pode ser convertido. Campos fora do esquema e valores vazios passam intactos.
 */
function normalizeTemporal(row, schema, options) {
  const out = { ...row };
  for (const def of schema) {
    const value = out[def.field];
    if (value === null || value === undefined || value === '') continue;
    if (def.type === 'date') out[def.field] = civilDay(value);
    else if (def.type === 'instant') {
      const result = instantOf(value, def.field, options);
      if (result.problem) return { row, verdict: { state: 'QUARANTINED', reason: result.problem.reason, code: result.problem.code } };
      out[def.field] = result.value;
    }
  }
  return { row: out, verdict: null };
}

module.exports = { normalizeTemporal, civilDay, instantOf, CODES, MESSAGES };
