'use strict';

/**
 * Contador do volume de log por dia (M9-D860, fonte do coletor de storage e da M9-D862): conta os bytes que o logger grava, por dia civil de
 * America/Sao_Paulo. Fica em memória do processo (um mapa de poucos dias); o coletor diário lê o dia fechado. Sem dependências, para o logger poder usá-lo.
 */
const TZ = 'America/Sao_Paulo';
const KEEP_DAYS = 8;
const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const days = new Map();

function add(bytes, now = new Date()) {
  const key = fmt.format(now);
  days.set(key, (days.get(key) || 0) + bytes);
  if (days.size > KEEP_DAYS) [...days.keys()].sort().slice(0, days.size - KEEP_DAYS).forEach((k) => days.delete(k));
}

/** Bytes de log gravados no dia (AAAA-MM-DD), ou null se este processo não observou o dia. */
const bytesOfDay = (dayKey) => (days.has(dayKey) ? days.get(dayKey) : null);
const reset = () => days.clear();

module.exports = { add, bytesOfDay, reset };
