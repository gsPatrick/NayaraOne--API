'use strict';
/**
 * Runner da captura de evidências dos Marcos 4/5 (conferência Nayara).
 *
 * Roda DENTRO do Postgres descartável (scripts/reproduzir-conferencia.sh com REPRO_CAPTURA=1, ou
 * o cluster de iteração) com os usuários fictícios de scripts/seed-ci-two-tenants.js. Cada passo
 * HTTP é uma requisição real ao app Express (auth JWT real + tenant + RLS) feita com o login do
 * perfil indicado. Nunca chama endpoint de MFA e nunca forja token: ações que exigem MFA são
 * registradas com a recusa real (MFA_REQUIRED_NOT_ENABLED / MFA_STEP_UP_REQUIRED) e a REGRA é
 * provada por passo de serviço (função da camada de serviço dentro de uma transação de tenant).
 *
 * O que NÃO é gravado: senha, access/refresh token (substituídos por [REDACTED] — declarado em
 * meta.sanitizacao do JSON de saída).
 */
const { emailFor } = require('../seed-ci-two-tenants');

const JWT_RE = /eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g;

function redigir(valor) {
  if (valor === null || valor === undefined) return valor;
  if (typeof valor === 'string') return valor.replace(JWT_RE, '[REDACTED]');
  if (Array.isArray(valor)) return valor.map(redigir);
  if (typeof valor === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(valor)) {
      if (/^(accessToken|refreshToken|token|password|passwordHash|senha)$/i.test(k) && typeof v === 'string') out[k] = '[REDACTED]';
      else out[k] = redigir(v);
    }
    return out;
  }
  return valor;
}

class Runner {
  constructor({ baseUrl, password }) {
    this.baseUrl = baseUrl;
    this.password = password;
    this.tokens = {};
    this.claims = {};
    this.passos = [];
    this.consultas = [];
    this.ctx = {};
    this.seq = 0;
  }

  async login(tenantKey, perfil) {
    const quem = `${tenantKey}:${perfil}`;
    const email = emailFor(tenantKey, perfil);
    const res = await fetch(`${this.baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: this.password }),
    });
    const body = await res.json();
    if (res.status !== 200) throw new Error(`login ${quem} falhou: ${res.status}`);
    this.tokens[quem] = body.data.accessToken;
    const payload = JSON.parse(Buffer.from(this.tokens[quem].split('.')[1], 'base64url').toString('utf8'));
    this.claims[quem] = { userId: payload.sub, groupId: payload.group_id, companyId: payload.company_id, permissions: payload.permissions };
    return quem;
  }

  tenant(quem) {
    const c = this.claims[quem];
    return { groupId: c.groupId, companyId: c.companyId, userId: c.userId };
  }

  /**
   * Passo HTTP. `corpo` e `rota` podem ser funções de ctx. `esperado` = { status, codigo? }.
   * Registra o corpo da resposta CRU (apenas tokens/senhas redigidos).
   */
  async http({ id, grupos = [], f = [], titulo, quem, metodo, rota, corpo, esperado, guardar, nota }) {
    this.seq += 1;
    const rotaFinal = typeof rota === 'function' ? rota(this.ctx) : rota;
    const corpoFinal = typeof corpo === 'function' ? corpo(this.ctx) : corpo;
    const headers = { 'Content-Type': 'application/json' };
    if (quem && quem !== 'anonimo') headers.Authorization = `Bearer ${this.tokens[quem]}`;
    const t0 = Date.now();
    const res = await fetch(`${this.baseUrl}${rotaFinal}`, {
      method: metodo,
      headers,
      body: corpoFinal !== undefined && metodo !== 'GET' ? JSON.stringify(corpoFinal) : undefined,
    });
    const ms = Date.now() - t0;
    const texto = await res.text();
    let corpoResp;
    try { corpoResp = JSON.parse(texto); } catch (_) { corpoResp = texto === '' ? null : texto; }
    const codigo = corpoResp && corpoResp.error ? corpoResp.error.code : null;
    const ok = res.status === esperado.status && (esperado.codigo === undefined || esperado.codigo === codigo);
    const passo = {
      id, tipo: 'http', grupos, f, titulo, perfil: quem || 'anonimo', metodo, rota: rotaFinal,
      corpoEnviado: corpoFinal === undefined ? null : redigir(corpoFinal),
      esperado, status: res.status, codigo, ok, ms,
      quando: new Date().toISOString(),
      corpo: redigir(corpoResp),
    };
    if (nota) passo.nota = nota;
    this.passos.push(passo);
    if (guardar) guardar(corpoResp, this.ctx, passo);
    if (!ok) console.error(`[captura] DIVERGÊNCIA ${id}: esperado ${JSON.stringify(esperado)}, veio ${res.status} ${codigo || ''}`);
    return { status: res.status, body: corpoResp, codigo, ok };
  }

  /**
   * Passo de serviço: roda `fn(ctx)` (camada de serviço, fora do HTTP) e registra o resultado ou
   * o erro (code/message) — usado onde a rota exige MFA humano, para provar a REGRA.
   */
  async servico({ id, grupos = [], f = [], titulo, chamada, fn, esperado, guardar }) {
    this.seq += 1;
    const t0 = Date.now();
    let resultado = null;
    let erro = null;
    try { resultado = await fn(this.ctx); } catch (err) { erro = { code: err.code || err.name, message: err.message }; }
    const ms = Date.now() - t0;
    const codigo = erro ? erro.code : null;
    const ok = esperado.erro ? codigo === esperado.erro : !erro;
    const passo = {
      id, tipo: 'servico', grupos, f, titulo, perfil: 'serviço (sem HTTP)', metodo: 'CALL', rota: chamada,
      corpoEnviado: null, esperado, status: erro ? 'erro' : 'ok', codigo, ok, ms,
      quando: new Date().toISOString(),
      corpo: erro ? { error: erro } : { result: redigir(resultado) },
    };
    this.passos.push(passo);
    if (guardar && !erro) guardar(resultado, this.ctx, passo);
    if (!ok) console.error(`[captura] DIVERGÊNCIA ${id}: esperado ${JSON.stringify(esperado)}, veio ${codigo || 'ok'}`);
    return { erro, resultado, ok };
  }

  /** Consulta SQL somente leitura (SELECT) ao banco descartável. */
  async sql({ id, grupos = [], f = [], descricao, sql, replacements, avaliar }) {
    const { sequelize } = require('../../src/models');
    let resultado;
    let erro = null;
    try { [resultado] = await sequelize.query(sql, { replacements }); } catch (err) { erro = err.message; }
    const invarianteOk = erro ? false : (avaliar ? !!avaliar(resultado) : true);
    this.consultas.push({ id, grupos, f, descricao, sql: sql.replace(/\s+/g, ' ').trim(), resultado: erro ? { erro } : redigir(resultado), invarianteOk, quando: new Date().toISOString() });
    if (!invarianteOk) console.error(`[captura] INVARIANTE FALHOU ${id}`);
  }
}

module.exports = { Runner, redigir };
