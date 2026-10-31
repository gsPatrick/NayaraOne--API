'use strict';

/**
 * Limite de chamadas por minuto para webhooks públicos (sem login): por IP + provider. Em memória
 * (por processo): segura o grosso de uma enxurrada antes de qualquer consulta ao banco. O valor vem
 * de WEBHOOK_RATE_LIMIT_PER_MINUTE (inteiro de 10 a 100000); valor inválido cai no padrão.
 */
const DEFAULT_PER_MINUTE = 120;

function parseLimit(raw) {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 10 && n <= 100000 ? n : DEFAULT_PER_MINUTE;
}

function createWebhookRateLimiter({ windowMs = 60000, max = parseLimit(process.env.WEBHOOK_RATE_LIMIT_PER_MINUTE), now = () => Date.now() } = {}) {
  const hits = new Map();
  return function webhookRateLimit(req, res, next) {
    // Suítes de teste disparam muitos webhooks do mesmo IP; o limite é desligado lá (exceto quando se testa o próprio limite).
    if (process.env.NODE_ENV === 'test' && process.env.WEBHOOK_RATE_LIMIT_FORCE !== 'true') return next();
    const t = now();
    if (hits.size > 5000) {
      for (const [key, entry] of hits) if (entry.resetAt <= t) hits.delete(key);
    }
    const key = `${req.ip || 'sem-ip'}|${String(req.params?.provider || '').toLowerCase()}`;
    const current = hits.get(key);
    if (!current || current.resetAt <= t) {
      hits.set(key, { count: 1, resetAt: t + windowMs });
      return next();
    }
    current.count += 1;
    if (current.count > max) {
      res.set('Retry-After', String(Math.max(1, Math.ceil((current.resetAt - t) / 1000))));
      return res.status(429).json({ success: false, error: { code: 'WEBHOOK_RATE_LIMITED', message: 'Muitas chamadas em pouco tempo. Tente novamente em instantes.' } });
    }
    return next();
  };
}

module.exports = { createWebhookRateLimiter, parseLimit };
