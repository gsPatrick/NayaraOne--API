'use strict';

/**
 * Tratadores de domínio do evento do fornecedor (M9-D236): o módulo de negócio de uma família (ex.: Jurídico, para SIGNATURE) registra UMA função que o worker chama,
 * na MESMA transação do evento, depois de aplicado (fora de ordem não chega aqui) e do envio ligado resolvido. `fn(ctx, row, ev, transaction)` devolve
 * `{ applied: false }` quando o domínio recusou ou ignorou o evento (ele fica no histórico, sem ir ao outbox) ou nada. Lançar erro desfaz o evento e ele volta a FAILED.
 */
const handlers = new Map();

const registerDomainHandler = (domain, fn) => { handlers.set(String(domain).toUpperCase(), fn); return () => handlers.delete(String(domain).toUpperCase()); };
const getDomainHandler = (domain) => handlers.get(String(domain || '').toUpperCase()) || null;

module.exports = { registerDomainHandler, getDomainHandler };
