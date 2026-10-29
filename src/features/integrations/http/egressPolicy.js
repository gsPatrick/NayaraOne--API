'use strict';

const AppError = require('../../../utils/AppError');

/**
 * Política de saída (M9-D244 3.1 e 3.2): só HTTPS (exceção: localhost em teste e em SANDBOX) e só para os hosts que o fornecedor
 * declara. Funções puras: decidem pelo texto da URL, ANTES de qualquer consulta de DNS. A URL fornecida por usuário ou terceiro
 * nunca amplia a lista (isso é do ssrfGuard, M9-D245).
 */
const LOCAL_HOSTS = Object.freeze(['localhost', '127.0.0.1', '::1']);
const MODES = Object.freeze(['enforce', 'log']);

const tlsRequired = (host) => new AppError('A integração exige conexão segura (HTTPS).', 502, 'INTEGRATION_TLS_REQUIRED', { host });
const egressBlocked = (host) => new AppError('Destino não permitido para esta integração.', 502, 'INTEGRATION_EGRESS_BLOCKED', { host });

/** Host (minúsculo, sem porta e sem colchetes) da URL, ou null se não for uma URL absoluta. */
function hostOf(url) {
  try { return new URL(String(url)).hostname.replace(/^\[|\]$/g, '').toLowerCase(); } catch { return null; }
}

/** 'api.x.com' casa exato; '*.x.com' casa qualquer subdomínio (não o próprio x.com). */
function matchHost(pattern, host) {
  const p = String(pattern || '').trim().toLowerCase();
  if (!p || !host) return false;
  if (p.startsWith('*.')) return host.endsWith(p.slice(1)) && host.length > p.length - 1;
  return host === p;
}

/** enforce em PRODUCTION e HOMOLOG, log em SANDBOX e DEV; `mode` explícito (parâmetro integration.egress.mode) vale sobre o padrão. */
function resolveEgressMode({ mode, environment, nodeEnv = process.env.NODE_ENV } = {}) {
  if (MODES.includes(mode)) return mode;
  if (environment) return environment === 'SANDBOX' ? 'log' : 'enforce';
  return nodeEnv === 'production' ? 'enforce' : 'log';
}

/** Lança 502 INTEGRATION_TLS_REQUIRED para qualquer coisa que não seja https (ou http local em teste/sandbox). */
function assertSecureScheme(url, { environment, nodeEnv = process.env.NODE_ENV } = {}) {
  let u;
  try { u = new URL(String(url)); } catch { throw tlsRequired(null); }
  if (u.protocol === 'https:') return u;
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (u.protocol === 'http:' && LOCAL_HOSTS.includes(host) && (nodeEnv === 'test' || environment === 'SANDBOX')) return u;
  throw tlsRequired(host);
}

/** { decision: 'ALLOWED' | 'LOGGED' | 'BLOCKED', host }. LOGGED = fora da lista em modo log; BLOCKED = fora da lista em enforce. */
function checkEgress({ url, allowedHosts = [], mode }) {
  const host = hostOf(url);
  if (host && allowedHosts.some((p) => matchHost(p, host))) return { decision: 'ALLOWED', host };
  return { decision: mode === 'enforce' ? 'BLOCKED' : 'LOGGED', host };
}

module.exports = { LOCAL_HOSTS, MODES, hostOf, matchHost, resolveEgressMode, assertSecureScheme, checkEgress, tlsRequired, egressBlocked };
