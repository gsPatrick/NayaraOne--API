'use strict';

/**
 * Conversão de horário local (sem fuso) para UTC com a base IANA do Node (M9-D908 §3.2). Função pura. Um horário local pode não existir (o relógio salta na entrada do horário de
 * verão), existir uma vez ou ocorrer duas vezes (o relógio volta na saída). Os instantes possíveis são os que, devolvidos ao fuso, dão o mesmo horário local.
 */
const LOCAL = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?)?$/;
const ZONED = /(?:Z|[+-]\d{2}(?::?\d{2})?)$/i;
const formatters = new Map();

function formatterOf(zone) {
  if (!formatters.has(zone)) {
    formatters.set(zone, new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }));
  }
  return formatters.get(zone);
}

/** O fuso é um nome IANA conhecido? */
function isValidZone(zone) {
  try { formatterOf(String(zone)); return true; } catch (err) { return false; }
}

/** Deslocamento do fuso em milissegundos (local - UTC) no instante `utcMs`. */
function offsetAt(utcMs, zone) {
  const parts = Object.fromEntries(formatterOf(zone).formatToParts(new Date(utcMs)).map((part) => [part.type, part.value]));
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/** Texto `AAAA-MM-DD[ T]HH:MM[:SS[.fff]]` sem fuso para as partes; null se não for esse formato ou a data não existir no calendário. */
function parseLocal(text) {
  const match = LOCAL.exec(String(text).trim());
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map((part) => Number(part || 0));
  const millis = match[7] ? Number(match[7].padEnd(3, '0').slice(0, 3)) : 0;
  const wall = Date.UTC(year, month - 1, day, hour, minute, second, millis);
  const back = new Date(wall);
  if (back.getUTCFullYear() !== year || back.getUTCMonth() !== month - 1 || back.getUTCDate() !== day || hour > 23 || minute > 59 || second > 59) return null;
  return { wall, hasTime: Boolean(match[4]), dateText: `${match[1]}-${match[2]}-${match[3]}` };
}

/**
 * Instantes UTC (ms) possíveis para o horário local `wall` (milissegundos como se o horário local fosse UTC) no fuso: [] (não existe), [x] ou [primeiro, segundo].
 */
function candidates(wall, zone) {
  const offsets = new Set([offsetAt(wall - 86400000, zone), offsetAt(wall + 86400000, zone), offsetAt(wall, zone)]);
  const found = [];
  for (const offset of offsets) {
    const utc = wall - offset;
    if (offsetAt(utc, zone) === offset && !found.includes(utc)) found.push(utc);
  }
  return found.sort((a, b) => a - b);
}

const STATUS = Object.freeze({ OK: 'OK', NONEXISTENT: 'NONEXISTENT', AMBIGUOUS: 'AMBIGUOUS', INVALID: 'INVALID' });

/**
 * Converte o horário local `text` do fuso `zone` para UTC. Devolve { status, utc?, first?, second? }: OK (um instante), AMBIGUOUS (dois: `first` e `second` em ISO UTC),
 * NONEXISTENT ou INVALID (formato/data inválidos). Texto que já traz fuso (Z ou deslocamento) é um instante e não passa por aqui (veja `hasExplicitZone`).
 */
function localToUtc(text, zone) {
  const parsed = parseLocal(text);
  if (!parsed || !parsed.hasTime) return { status: STATUS.INVALID };
  const list = candidates(parsed.wall, zone);
  if (!list.length) return { status: STATUS.NONEXISTENT };
  if (list.length === 1) return { status: STATUS.OK, utc: new Date(list[0]).toISOString() };
  return { status: STATUS.AMBIGUOUS, first: new Date(list[0]).toISOString(), second: new Date(list[1]).toISOString() };
}

const hasExplicitZone = (text) => typeof text === 'string' && /[T ]\d{2}:\d{2}/.test(text) && ZONED.test(text.trim());

module.exports = { localToUtc, parseLocal, hasExplicitZone, isValidZone, offsetAt, STATUS };
