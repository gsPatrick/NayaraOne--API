'use strict';

/**
 * Atraso da nova tentativa (M9-D216 3.2): atraso(n) = min(cap, base * fator^(n-1)) * (1 + jitter), com jitter uniforme em
 * [-jitter_pct, +jitter_pct]. `n` é a tentativa que acabou de falhar (1 = a primeira). `rand` devolve [0,1) (injetável nos testes).
 */
function backoffMs(attempt, retry, rand = Math.random) {
  const n = Math.max(1, Number(attempt) || 1);
  const bruto = Math.min(retry.cap_delay_ms, retry.base_delay_ms * (retry.factor ** (n - 1)));
  const jitter = ((rand() * 2) - 1) * (retry.jitter_pct / 100);
  return Math.max(0, Math.round(bruto * (1 + jitter)));
}

/** Faixa [mín, máx] do atraso de uma tentativa (a prova de que o jitter respeita a política). */
function backoffRangeMs(attempt, retry) {
  const bruto = Math.min(retry.cap_delay_ms, retry.base_delay_ms * (retry.factor ** (Math.max(1, attempt) - 1)));
  const j = retry.jitter_pct / 100;
  return [Math.round(bruto * (1 - j)), Math.round(bruto * (1 + j))];
}

/** Retry-After em milissegundos: segundos inteiros ou data HTTP; inválido ou passado devolve null. */
function parseRetryAfterMs(value, now = new Date()) {
  if (value === undefined || value === null || value === '') return null;
  const texto = String(value).trim();
  if (/^\d+(\.\d+)?$/.test(texto)) return Math.round(Number(texto) * 1000);
  const quando = Date.parse(texto);
  if (Number.isNaN(quando)) return null;
  return Math.max(0, quando - now.getTime());
}

/** Lê o cabeçalho de um erro ou resposta (objeto com get() ou propriedades). */
function headerOf(source, name) {
  const h = source && source.headers;
  if (!h) return null;
  if (typeof h.get === 'function') {
    const v = h.get(name);
    if (v !== null && v !== undefined) return v;
  }
  const chave = Object.keys(h).find((k) => k.toLowerCase() === name);
  return chave ? h[chave] : null;
}

module.exports = { backoffMs, backoffRangeMs, parseRetryAfterMs, headerOf };
