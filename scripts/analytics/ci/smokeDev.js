#!/usr/bin/env node
'use strict';

/**
 * M9-D705 etapa 12 — smoke do ambiente promovido: cada `GET /analytics/dashboards/<código>` do catálogo responde 200.
 *
 * Alvo (decisão do Patrick de 16/11/2026, sem servidor novo): LAB = a homologação publicada; DEV = a esteira do GitHub com banco descartável.
 * O endereço vem do segredo DEV_API_BASE_URL (nome mantido; aponta para a homologação, com /api/v1). Sem ele a etapa reprova: nunca inventa host.
 *
 * Credencial: login de um usuário de teste SOMENTE LEITURA (segredos DEV_SMOKE_EMAIL e DEV_SMOKE_PASSWORD; DEV_SMOKE_COMPANY_ID opcional),
 * porque um token fixo expira. DEV_SMOKE_TOKEN segue aceito como alternativa. Senha e token nunca são impressos nem entram em mensagem de erro.
 * Login que pede MFA (erro MFA_*, desafio sem accessToken ou mfaSetupRequired) reprova com mensagem clara: o smoke não tem segundo fator.
 * Antes dos GETs, as permissões devolvidas pelo login são comparadas com as que os painéis exigem (`permissoesDoSmoke`): falta reprova dizendo
 * qual permissão e qual painel. Ao final a sessão aberta pelo login é encerrada (POST /auth/logout).
 */
const { DASHBOARD_CATALOG } = require('../../../src/features/analytics/dashboards/dashboard.catalog');

const ROTULO_ALVO = 'LAB = homologação publicada (DEV_API_BASE_URL); DEV = esteira do GitHub com banco descartável (decisão do Patrick de 16/11/2026)';
const LEITURA_DO_BI = 'analytics:read'; // a rota de painéis exige esta antes da permissão própria do painel (dashboard.routes.js)
const TEMPO_MAXIMO_MS = 30000;

class SmokeError extends Error {}

/** Permissões que o usuário do smoke precisa: `analytics:read` mais a `requiredPermission` de cada painel do catálogo. */
function permissoesDoSmoke(catalogo = DASHBOARD_CATALOG) {
  const porPermissao = new Map([[LEITURA_DO_BI, catalogo.map((p) => p.code)]]);
  for (const p of catalogo) {
    if (!porPermissao.has(p.requiredPermission)) porPermissao.set(p.requiredPermission, []);
    if (p.requiredPermission !== LEITURA_DO_BI) porPermissao.get(p.requiredPermission).push(p.code);
  }
  return [...porPermissao.entries()].map(([permissao, paineis]) => ({ permissao, paineis })).sort((a, b) => a.permissao.localeCompare(b.permissao));
}

function lerConfig(env) {
  const base = String(env.DEV_API_BASE_URL || '').trim().replace(/\/+$/, '');
  if (!base) throw new SmokeError('Alvo não configurado (segredo DEV_API_BASE_URL, que aponta para a homologação publicada): a promoção fica bloqueada.');
  const email = String(env.DEV_SMOKE_EMAIL || '').trim();
  const senha = env.DEV_SMOKE_PASSWORD || '';
  const token = String(env.DEV_SMOKE_TOKEN || '').trim();
  if (email && !senha) throw new SmokeError('DEV_SMOKE_EMAIL sem DEV_SMOKE_PASSWORD: configure os dois segredos do usuário de smoke.');
  if (!email && senha) throw new SmokeError('DEV_SMOKE_PASSWORD sem DEV_SMOKE_EMAIL: configure os dois segredos do usuário de smoke.');
  if (!email && !token) throw new SmokeError('Credencial do smoke não configurada (DEV_SMOKE_EMAIL e DEV_SMOKE_PASSWORD, ou DEV_SMOKE_TOKEN): a promoção fica bloqueada.');
  return { base, email, senha, token, companyId: String(env.DEV_SMOKE_COMPANY_ID || '').trim() || null };
}

async function lerJson(resposta) {
  try { return await resposta.json(); } catch { return null; }
}

const codigoDoErro = (corpo) => (corpo && corpo.error && typeof corpo.error.code === 'string' ? corpo.error.code : null);
const pedeMfa = (dados) => Boolean(dados && (dados.mfaRequired || dados.mfaSetupRequired || dados.mfaChallenge || dados.challengeId || dados.mfaToken));

function erroDeMfa(detalhe) {
  return new SmokeError(`O login do usuário de smoke pediu MFA (${detalhe}). O smoke não tem segundo fator: use um usuário de teste somente leitura com MFA já configurada e sem pendência de configuração, ou cadastre DEV_SMOKE_TOKEN.`);
}

/** Login (POST /auth/login) ou o token cadastrado. Devolve { token, refreshToken, permissoes (null quando veio do token), origem }. */
async function obterCredencial(config, fetchImpl) {
  if (!config.email) return { token: config.token, refreshToken: null, permissoes: null, origem: 'DEV_SMOKE_TOKEN' };
  let resposta;
  try {
    resposta = await fetchImpl(`${config.base}/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(TEMPO_MAXIMO_MS),
      body: JSON.stringify({ email: config.email, password: config.senha, ...(config.companyId ? { companyId: config.companyId } : {}) }),
    });
  } catch (e) {
    throw new SmokeError(`Login do usuário de smoke sem resposta (${e.name}).`);
  }
  const corpo = await lerJson(resposta);
  const codigo = codigoDoErro(corpo);
  if (codigo && /^MFA_/.test(codigo)) throw erroDeMfa(`HTTP ${resposta.status} ${codigo}`);
  if (resposta.status !== 200) throw new SmokeError(`Login do usuário de smoke recusado: HTTP ${resposta.status}${codigo ? ` ${codigo}` : ''}.`);
  const dados = corpo && corpo.data;
  if (pedeMfa(dados)) throw erroDeMfa(dados.mfaSetupRequired ? 'mfaSetupRequired: a conta precisa configurar MFA' : 'desafio de segundo fator');
  if (!dados || typeof dados.accessToken !== 'string' || !dados.accessToken) throw new SmokeError('O login do usuário de smoke respondeu 200 sem accessToken.');
  return { token: dados.accessToken, refreshToken: dados.refreshToken || null, permissoes: Array.isArray(dados.permissions) ? dados.permissions : null, origem: 'login' };
}

function permissoesFaltando(permissoes, exigidas = permissoesDoSmoke()) {
  if (!permissoes) return [];
  const tem = new Set(permissoes);
  return exigidas.filter((e) => !tem.has(e.permissao));
}

async function encerrarSessao(config, credencial, fetchImpl) {
  if (credencial.origem !== 'login' || !credencial.refreshToken) return 'sem sessão a encerrar';
  try {
    const r = await fetchImpl(`${config.base}/auth/logout`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken: credencial.refreshToken }), signal: AbortSignal.timeout(TEMPO_MAXIMO_MS),
    });
    return `logout HTTP ${r.status}`;
  } catch (e) {
    return `logout sem resposta (${e.name})`;
  }
}

/** Roda o smoke. `log` recebe cada linha (nunca senha nem token). Devolve { ok, falhas, total, resultados, origem }; erro de configuração lança SmokeError. */
async function rodarSmoke({ env = process.env, fetchImpl = fetch, log = console.log, catalogo = DASHBOARD_CATALOG } = {}) {
  const config = lerConfig(env);
  log(`alvo: ${ROTULO_ALVO}`);
  const credencial = await obterCredencial(config, fetchImpl);
  log(`credencial: ${credencial.origem === 'login' ? 'login do usuário de smoke (DEV_SMOKE_EMAIL)' : 'DEV_SMOKE_TOKEN'}`);
  try {
    const faltando = permissoesFaltando(credencial.permissoes, permissoesDoSmoke(catalogo));
    if (faltando.length) {
      throw new SmokeError(`O usuário de smoke não tem ${faltando.length} permissão(ões) que os painéis exigem: ${faltando.map((f) => `${f.permissao} (${f.paineis.join(', ')})`).join('; ')}.`);
    }
    const resultados = [];
    for (const painel of catalogo) {
      const caminho = `/analytics/dashboards/${encodeURIComponent(painel.code)}`;
      let status = 0;
      let codigo = null;
      try {
        const r = await fetchImpl(`${config.base}${caminho}`, { headers: { Authorization: `Bearer ${credencial.token}` }, signal: AbortSignal.timeout(TEMPO_MAXIMO_MS) });
        status = r.status;
        codigo = status === 200 ? null : codigoDoErro(await lerJson(r));
      } catch (e) {
        codigo = `SEM_RESPOSTA_${e.name}`;
      }
      resultados.push({ painel: painel.code, status, codigo });
      log(`GET ${caminho}: ${status || 'sem resposta'}${codigo ? ` ${codigo}` : ''}`);
    }
    const falhas = resultados.filter((r) => r.status !== 200);
    if (falhas.some((f) => f.codigo && /^MFA_/.test(f.codigo))) log('Atenção: painel recusado por MFA (MFA_*): o usuário de smoke não pode depender de segundo fator.');
    return { ok: falhas.length === 0, falhas: falhas.length, total: resultados.length, resultados, origem: credencial.origem };
  } finally {
    log(`sessão: ${await encerrarSessao(config, credencial, fetchImpl)}`);
  }
}

async function main() {
  const r = await rodarSmoke();
  if (!r.ok) throw new SmokeError(`${r.falhas} de ${r.total} painel(is) responderam diferente de 200.`);
  console.log(`OK: ${r.total} painel(is) responderam 200 no LAB (homologação publicada).`);
}

if (require.main === module) main().catch((e) => { console.error(`Smoke reprovado: ${e.message}`); process.exitCode = 1; });

module.exports = { rodarSmoke, permissoesDoSmoke, lerConfig, obterCredencial, permissoesFaltando, ROTULO_ALVO, SmokeError };
