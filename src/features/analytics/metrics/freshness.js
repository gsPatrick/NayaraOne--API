'use strict';

/**
 * M9-D609 (3.1 e 3.2) — freshness calculada no servidor, a partir de `source_snapshot_at` (quando a FONTE foi lida; um refresh novo sobre fonte
 * velha continua velho). Estados: FRESH (idade <= limite), STALE (acima do limite), EXPIRED (acima de fator x limite), UNKNOWN (nunca atualizado).
 * Idade em minutos inteiros (arredondada para baixo) pelo relógio injetável. O limite vem do parâmetro do domínio quando o administrador o configurou, senão do
 * `maxStalenessMinutes` da refresh_policy da versão da métrica, senão do padrão do livro por domínio (`analytics.freshness.max_minutos.<DOMINIO>`). Tudo aqui é puro (sem banco).
 */
const { BUSINESS_TIMEZONE } = require('../../../utils/businessDate');

const STATES = Object.freeze({ FRESH: 'FRESH', STALE: 'STALE', EXPIRED: 'EXPIRED', UNKNOWN: 'UNKNOWN' });
const EXPIRED_TEXT = 'Dado antigo, não use para decidir';

/** Idade em minutos inteiros entre dois instantes (nunca negativa); null se faltar um deles. */
function ageMinutesBetween(from, to) {
  if (!from || !to) return null;
  return Math.max(0, Math.floor((new Date(to).getTime() - new Date(from).getTime()) / 60000));
}

/**
 * Limite de idade da métrica: o do domínio que o administrador configurou (`analytics.freshness.max_minutos.<DOMINIO>`); sem ele, o
 * `maxStalenessMinutes` da política de atualização da versão; sem os dois, o padrão do livro para o domínio.
 */
function maxStalenessOf(refreshPolicy, domain, params) {
  if (params.overrides && Number.isInteger(params.overrides[domain])) return params.overrides[domain];
  const own = refreshPolicy && refreshPolicy.maxStalenessMinutes;
  if (Number.isInteger(own) && own >= 1) return own;
  const byDomain = params.limits[domain];
  if (!Number.isInteger(byDomain)) throw new Error(`Domínio de freshness sem limite: ${domain}`);
  return byDomain;
}

function classify(ageMinutes, limit, factor) {
  if (ageMinutes === null) return STATES.UNKNOWN;
  if (ageMinutes <= limit) return STATES.FRESH;
  return ageMinutes > limit * factor ? STATES.EXPIRED : STATES.STALE;
}

/** "3 h", "45 min", "2 d": a idade como o selo mostra. */
function ageText(minutes) {
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} h`;
  return `${Math.floor(minutes / 1440)} d`;
}

const clockText = (instant) => new Intl.DateTimeFormat('pt-BR', { timeZone: BUSINESS_TIMEZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(instant));

function labelOf(state, ageMinutes, sourceSnapshotAt) {
  if (state === STATES.FRESH) return `Atualizado às ${clockText(sourceSnapshotAt)}`;
  if (state === STATES.STALE) return `Desatualizado há ${ageText(ageMinutes)}`;
  if (state === STATES.EXPIRED) return EXPIRED_TEXT;
  return 'Ainda sem atualização';
}

/**
 * Bloco `freshness` da resposta. `now` é o instante da leitura; `historical` (leitura de dia passado) mede a idade que o dado tinha quando foi
 * gravado (refreshed_at - source_snapshot_at), porque um snapshot antigo é antigo por definição e continua legível como registro do passado.
 */
function computeFreshness({ asOfDate = null, sourceSnapshotAt, refreshedAt, maxStalenessMinutes, factor, now, historical = false }) {
  const ageMinutes = sourceSnapshotAt ? ageMinutesBetween(sourceSnapshotAt, historical ? refreshedAt : now) : null;
  const state = classify(ageMinutes, maxStalenessMinutes, factor);
  return {
    state, ageMinutes, asOfDate, sourceSnapshotAt: sourceSnapshotAt || null, refreshedAt: refreshedAt || null, maxStalenessMinutes,
    expiredAboveMinutes: maxStalenessMinutes * factor, historical, label: labelOf(state, ageMinutes, sourceSnapshotAt),
  };
}

/** Compatível com a M9-D614: os campos de tempo do snapshot, sem classificar (a classificação exige versão e parâmetros: `present`). */
function buildFreshness(asOfDate, snapshot) {
  return { asOfDate, sourceSnapshotAt: snapshot.source_snapshot_at, refreshedAt: snapshot.refreshed_at };
}

module.exports = { STATES, EXPIRED_TEXT, ageMinutesBetween, maxStalenessOf, classify, ageText, computeFreshness, buildFreshness };
