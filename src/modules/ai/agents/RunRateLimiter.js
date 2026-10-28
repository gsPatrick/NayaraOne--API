'use strict';

const E = require('./agents.errors');

const WINDOW_MS = 60000;

/**
 * Janela deslizante de um minuto por chave (empresa + usuário). Memória do processo: serve a uma instância da API; o contador
 * por banco (runs recentes do usuário) entra com ai.runs da M9-D005, sem mudar este contrato (`assertAllowed`).
 */
class RunRateLimiter {
  constructor() {
    this.hits = new Map();
  }

  assertAllowed({ key, limit, now = Date.now() }) {
    const recent = (this.hits.get(key) || []).filter((t) => now - t < WINDOW_MS);
    if (recent.length >= limit) {
      this.hits.set(key, recent);
      throw E.rateLimited();
    }
    recent.push(now);
    this.hits.set(key, recent);
  }
}

const defaultRunRateLimiter = new RunRateLimiter();

module.exports = { RunRateLimiter, defaultRunRateLimiter, WINDOW_MS };
