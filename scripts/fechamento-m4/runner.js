'use strict';
/**
 * Runner da captura do fechamento do Marco 4 (matriz do caderno, 265 linhas).
 *
 * Estende o Runner de scripts/captura-marco45 com: cabeçalhos por passo (Idempotency-Key, assinatura
 * do webhook), marcação de cada passo com as LINHAS da matriz que ele prova (`linhas`), passos de
 * PREPARAÇÃO declarados (fixtures pela camada de serviço, nunca contando como prova) e MFA pela
 * camada de serviço real.
 *
 * MFA: nunca chama endpoint de MFA por HTTP e nunca forja token. Os usuários fictícios do seed de
 * dois tenants habilitam e verificam o MFA pela camada de serviço (mfa.service setupMfa/confirmMfa/
 * verifyMfa) com um código TOTP real gerado a partir do segredo devolvido pelo setup. O segredo e os
 * códigos ficam só em memória e nunca entram na saída.
 */
const { Runner, redigir } = require('../captura-marco45/runner');

const CHAVES_SECRETAS = /^(accessToken|refreshToken|token|password|passwordHash|senha|secret|secretEncrypted|webhookSecret|otpauthUri|otpauthUrl|recoveryCodes|contentBase64)$/i;

function redigirFundo(valor) {
  if (valor === null || valor === undefined) return valor;
  if (Array.isArray(valor)) return valor.map(redigirFundo);
  if (typeof valor === 'object' && !(valor instanceof Date)) {
    const out = {};
    for (const [k, v] of Object.entries(valor)) {
      if (CHAVES_SECRETAS.test(k) && v !== null && v !== undefined && typeof v !== 'object') out[k] = '[REDACTED]';
      else if (CHAVES_SECRETAS.test(k) && Array.isArray(v)) out[k] = '[REDACTED]';
      else out[k] = redigirFundo(v);
    }
    return out;
  }
  return redigir(valor);
}

class RunnerM4 extends Runner {
  constructor(opts) {
    super(opts);
    this.preparacao = [];
    this.mfaSegredos = new Map();
  }

  /** Passo HTTP com linhas da matriz e cabeçalhos extras. */
  async http({ id, linhas = [], titulo, quem, metodo, rota, corpo, cabecalhos, corpoBruto, esperado, guardar, nota }) {
    this.seq += 1;
    const rotaFinal = typeof rota === 'function' ? rota(this.ctx) : rota;
    const corpoFinal = typeof corpo === 'function' ? corpo(this.ctx) : corpo;
    const extras = typeof cabecalhos === 'function' ? cabecalhos(this.ctx) : cabecalhos || {};
    const bruto = typeof corpoBruto === 'function' ? corpoBruto(this.ctx) : corpoBruto;
    const headers = { 'Content-Type': 'application/json', ...extras };
    if (quem && quem !== 'anonimo') headers.Authorization = `Bearer ${this.tokens[quem]}`;
    const t0 = Date.now();
    const url = rotaFinal.startsWith('@') ? `${this.baseUrl.replace(/\/v1$/, '')}${rotaFinal.slice(1)}` : `${this.baseUrl}${rotaFinal}`;
    const res = await fetch(url, {
      method: metodo,
      headers,
      body: bruto !== undefined ? bruto : corpoFinal !== undefined && metodo !== 'GET' ? JSON.stringify(corpoFinal) : undefined,
    });
    const ms = Date.now() - t0;
    const texto = await res.text();
    let corpoResp;
    try { corpoResp = JSON.parse(texto); } catch (_) { corpoResp = texto === '' ? null : texto; }
    const codigo = corpoResp && corpoResp.error ? corpoResp.error.code : null;
    const statusOk = Array.isArray(esperado.status) ? esperado.status.includes(res.status) : res.status === esperado.status;
    const ok = statusOk && (esperado.codigo === undefined || esperado.codigo === codigo);
    const cabecalhosEnviados = Object.fromEntries(Object.entries(extras).map(([k, v]) => [k, /signature/i.test(k) ? `${String(v).slice(0, 13)}…(assinatura HMAC calculada no envio)` : v]));
    const passo = {
      id, tipo: 'http', linhas, titulo, perfil: quem || 'anonimo', metodo, rota: rotaFinal,
      cabecalhosEnviados: Object.keys(cabecalhosEnviados).length ? cabecalhosEnviados : 'somente Content-Type e Authorization (token omitido)',
      corpoEnviado: bruto !== undefined ? redigirFundo(JSON.parse(bruto)) : corpoFinal === undefined ? 'sem corpo' : redigirFundo(corpoFinal),
      esperado, status: res.status, codigo: codigo || 'não se aplica (sem código de erro)', ok, ms,
      quando: new Date().toISOString(),
      cabecalhosResposta: Object.fromEntries(['content-type', 'x-content-type-options', 'x-frame-options', 'strict-transport-security', 'content-security-policy', 'referrer-policy', 'x-request-id'].filter((h) => res.headers.get(h)).map((h) => [h, res.headers.get(h)])),
      corpo: redigirFundo(corpoResp),
    };
    if (nota) passo.nota = nota;
    this.passos.push(passo);
    if (guardar && ok) {
      try { guardar(corpoResp, this.ctx, passo); } catch (err) { console.error(`[captura] guardar ${id}: ${err.message}`); }
    }
    if (!ok) console.error(`[captura] DIVERGÊNCIA ${id}: esperado ${JSON.stringify(esperado)}, veio ${res.status} ${codigo || ''} ${JSON.stringify(corpoResp).slice(0, 300)}`);
    return { status: res.status, body: corpoResp, codigo, ok };
  }

  /** Várias requisições HTTP SIMULTÂNEAS (Promise.all), cada uma registrada como passo. */
  async paralelo(passos) {
    return Promise.all(passos.map((p) => this.http(p)));
  }

  /** Preparação de fixture pela camada de serviço (não é prova; fica declarada na saída). */
  async preparar(id, descricao, fn) {
    const t0 = Date.now();
    try {
      const r = await fn(this.ctx);
      this.preparacao.push({ id, descricao, ok: true, ms: Date.now() - t0, quando: new Date().toISOString() });
      return r;
    } catch (err) {
      this.preparacao.push({ id, descricao, ok: false, erro: `${err.code || err.name}: ${err.message}`, quando: new Date().toISOString() });
      console.error(`[captura] PREPARAÇÃO FALHOU ${id}: ${err.code || ''} ${err.message}`);
      throw err;
    }
  }

  /**
   * MFA pela camada de serviço real, com código TOTP real (nenhum endpoint de MFA por HTTP, nenhum
   * token forjado). `habilitarMfa` = setupMfa + confirmMfa; `verificarMfa` = verifyMfa (step-up).
   * Segredo e códigos ficam só em memória.
   */
  async habilitarMfa(quem, inTenant) {
    const { authenticator } = require('otplib');
    const mfaService = require('../../src/features/users/mfa.service');
    const t = this.tenant(quem);
    return this.servico({
      id: `MFA-HAB-${quem}`,
      titulo: `MFA de ${quem} habilitado pela camada de serviço (setupMfa + confirmMfa com código TOTP real); nenhum endpoint de MFA chamado por HTTP`,
      chamada: 'mfa.service.setupMfa + mfa.service.confirmMfa(código TOTP real)',
      esperado: {},
      fn: async () => {
        const { otpauthUri } = await inTenant(t, (tx) => mfaService.setupMfa(t.userId, t, tx));
        const segredo = new URL(otpauthUri).searchParams.get('secret');
        this.mfaSegredos.set(quem, { segredo, ultimaJanela: Math.floor(Date.now() / 30000) });
        await inTenant(t, (tx) => mfaService.confirmMfa(t.userId, authenticator.generate(segredo), t, tx));
        return { perfil: quem, mfaHabilitado: true, observacao: 'segredo TOTP, códigos e códigos de recuperação não são gravados' };
      },
    });
  }

  async verificarMfa(quem, inTenant) {
    const { authenticator } = require('otplib');
    const mfaService = require('../../src/features/users/mfa.service');
    const t = this.tenant(quem);
    const reg = this.mfaSegredos.get(quem);
    // Um código TOTP só vale uma vez: espera a próxima janela de 30 s se a atual já foi usada.
    while (Math.floor(Date.now() / 30000) <= reg.ultimaJanela) await new Promise((r) => setTimeout(r, 1000));
    reg.ultimaJanela = Math.floor(Date.now() / 30000);
    return this.servico({
      id: `MFA-VER-${quem}-${this.seq + 1}`,
      titulo: `Step-up MFA de ${quem}: código TOTP real verificado pela camada de serviço (verifyMfa); nenhum endpoint de MFA chamado por HTTP`,
      chamada: 'mfa.service.verifyMfa(código TOTP real)',
      esperado: {},
      fn: async () => {
        await inTenant(t, (tx) => mfaService.verifyMfa(t.userId, authenticator.generate(reg.segredo), t, tx));
        return { perfil: quem, verificacaoRecente: true, observacao: 'código não gravado' };
      },
    });
  }
}

module.exports = { RunnerM4, redigirFundo };
