'use strict';
/**
 * Cliente HTTP do roteiro de aceite do Marco 9. Só fala com a API pública (nunca SQL).
 * - Recusa endereço de produção (trava de segurança: hoje não existe produção).
 * - Login normal por POST /auth/login. MFA nunca é contornado: se a API pedir MFA e o código não vier
 *   em HOMO_ADMIN_MFA_CODE, o script para com mensagem clara.
 */
const BASE_PADRAO = 'http://127.0.0.1:4001/api/v1';

class PararScript extends Error {
  constructor(mensagem, codigoSaida = 2) {
    super(mensagem);
    this.name = 'PararScript';
    this.codigoSaida = codigoSaida;
  }
}

function lerBase(env = process.env) {
  const base = String(env.HOMO_API_BASE || BASE_PADRAO).replace(/\/+$/, '');
  let host;
  try { host = new URL(base).hostname.toLowerCase(); } catch (_) { throw new PararScript(`HOMO_API_BASE inválida: "${base}".`); }
  if (host.includes('producao') || host.includes('prod.') || host.startsWith('prod-') || host === 'prod') {
    throw new PararScript(`RECUSADO: HOMO_API_BASE aponta para "${host}", que parece produção. Este roteiro só roda em homologação ou ambiente local.`);
  }
  return base;
}

const dormir = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** Sessão de um perfil: guarda o token e faz as chamadas. */
class Sessao {
  constructor(base, rotulo, email, senha, codigoMfa) {
    this.base = base; this.rotulo = rotulo; this.email = email; this.senha = senha; this.codigoMfa = codigoMfa || null;
    this.token = null; this.userId = null; this.companyId = null; this.mfaFeito = false;
  }

  async entrar() {
    const r = await this.chamar('POST', '/auth/login', { email: this.email, password: this.senha }, { semToken: true });
    const dados = r.dados || {};
    const pediuMfa = dados.mfaRequired || dados.requiresMfa || (r.erro && /MFA/i.test(`${r.erro.code} ${r.erro.message}`));
    if (pediuMfa) {
      if (!this.codigoMfa) throw new PararScript(`O login de ${this.rotulo} pediu MFA e HOMO_ADMIN_MFA_CODE não foi informado. Informe o código do aplicativo autenticador e rode de novo (o script nunca contorna MFA).`);
      throw new PararScript(`O login de ${this.rotulo} pediu MFA no próprio login, fluxo que este script não completa. Entre pela tela, depois rode de novo.`);
    }
    if (r.status !== 200 || !dados.accessToken) throw new PararScript(`Login de ${this.rotulo} (${this.email}) falhou: HTTP ${r.status}${r.erro ? ` ${r.erro.code}` : ''}.`);
    this.token = dados.accessToken;
    this.userId = (dados.user && dados.user.id) || null;
    this.companyId = dados.companyId || (dados.company && dados.company.id) || null;
    return this;
  }

  /** Passo de segurança (MFA recente) só com o código informado pela pessoa; nunca forjado. */
  async confirmarMfa() {
    if (!this.codigoMfa) throw new PararScript(`A API exigiu MFA recente para ${this.rotulo}. Informe HOMO_ADMIN_MFA_CODE (código do aplicativo autenticador) e rode de novo.`);
    const r = await this.chamar('POST', '/users/me/mfa/verify', { code: this.codigoMfa }, { semMfaAutomatico: true });
    if (r.status >= 300) throw new PararScript(`O código MFA informado foi recusado (HTTP ${r.status}). Gere um código novo e rode de novo.`);
    this.mfaFeito = true;
  }

  async chamar(metodo, rota, corpo, opcoes = {}) {
    const cabecalhos = { Accept: 'application/json' };
    if (corpo !== undefined) cabecalhos['Content-Type'] = 'application/json';
    if (this.token && !opcoes.semToken) cabecalhos.Authorization = `Bearer ${this.token}`;
    const res = await fetch(`${this.base}${rota}`, { method: metodo, headers: cabecalhos, body: corpo !== undefined ? JSON.stringify(corpo) : undefined });
    const texto = await res.text();
    let json = null;
    try { json = texto ? JSON.parse(texto) : null; } catch (_) { json = null; }
    const resp = {
      status: res.status, corpo: json, texto,
      dados: json && typeof json === 'object' && 'data' in json ? json.data : json,
      erro: json && json.error ? json.error : null,
    };
    if (res.status === 403 && resp.erro && /^MFA_/.test(String(resp.erro.code)) && !opcoes.semMfaAutomatico && !opcoes.jaTentouMfa) {
      await this.confirmarMfa();
      return this.chamar(metodo, rota, corpo, { ...opcoes, jaTentouMfa: true });
    }
    return resp;
  }
}

module.exports = { Sessao, PararScript, lerBase, dormir, BASE_PADRAO };
