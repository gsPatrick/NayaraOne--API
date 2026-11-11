'use strict';
/**
 * Cliente HTTP do roteiro de aceite do Marco 9. Só fala com a API pública (nunca SQL).
 * - Recusa endereço de produção (trava de segurança: hoje não existe produção).
 * - Login normal por POST /auth/login. Com `companyId`, entra direto naquela empresa (usuário com vínculo em mais de
 *   uma empresa do grupo, ex.: HOMO_OUTRA_EMPRESA_COMPANY_ID); a empresa devolvida pela API é conferida.
 * - MFA nunca é contornado: quando a API pede MFA recente, o script chama POST /users/me/mfa/verify com um código
 *   TOTP de verdade. O código vem de HOMO_<PERFIL>_MFA_CODE (digitado pela pessoa) ou é GERADO na hora a partir de
 *   HOMO_<PERFIL>_MFA_SECRET, o segredo TOTP do usuário de TESTE (o mesmo que o aplicativo autenticador guarda). Sem
 *   nenhum dos dois o script para com mensagem clara. Código e segredo nunca são impressos.
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

/** Código TOTP atual do segredo informado (otplib, o mesmo algoritmo do aplicativo autenticador). */
function gerarCodigoTotp(segredo) {
  const { authenticator } = require('otplib');
  return authenticator.generate(String(segredo).replace(/\s+/g, ''));
}

/** Segundos até o próximo código TOTP (janela de 30 s): códigos já usados podem ser recusados por proteção contra replay. */
function segundosParaProximaJanela() {
  const { authenticator } = require('otplib');
  return authenticator.timeRemaining();
}

/** Sessão de um perfil: guarda o token e faz as chamadas. */
class Sessao {
  /** opcoes: { codigoMfa, segredoMfa, companyId }. Aceita também a forma antiga (5º argumento = código MFA). */
  constructor(base, rotulo, email, senha, opcoes = {}) {
    const o = typeof opcoes === 'string' || opcoes === null ? { codigoMfa: opcoes } : (opcoes || {});
    this.base = base; this.rotulo = rotulo; this.email = email; this.senha = senha;
    this.codigoMfa = o.codigoMfa || null; this.segredoMfa = o.segredoMfa || null; this.empresaPedida = o.companyId || null;
    this.token = null; this.userId = null; this.companyId = null; this.groupId = null; this.mfaFeito = false;
  }

  get temMfa() { return Boolean(this.codigoMfa || this.segredoMfa); }

  async entrar() {
    const corpo = { email: this.email, password: this.senha };
    if (this.empresaPedida) corpo.companyId = this.empresaPedida;
    const r = await this.chamar('POST', '/auth/login', corpo, { semToken: true });
    const dados = r.dados || {};
    const pediuMfa = dados.mfaRequired || dados.requiresMfa || (r.erro && /MFA/i.test(`${r.erro.code} ${r.erro.message}`));
    if (pediuMfa) {
      if (!this.temMfa) throw new PararScript(`O login de ${this.rotulo} pediu MFA e nem o código nem o segredo TOTP de teste foram informados. Informe HOMO_*_MFA_CODE ou HOMO_*_MFA_SECRET e rode de novo (o script nunca contorna MFA).`);
      throw new PararScript(`O login de ${this.rotulo} pediu MFA no próprio login, fluxo que este script não completa. Entre pela tela, depois rode de novo.`);
    }
    if (r.status !== 200 || !dados.accessToken) throw new PararScript(`Login de ${this.rotulo} (${this.email}) falhou: HTTP ${r.status}${r.erro ? ` ${r.erro.code}` : ''}.`);
    this.token = dados.accessToken;
    this.userId = (dados.user && dados.user.id) || null;
    const claims = lerClaims(this.token);
    this.companyId = dados.companyId || (dados.company && dados.company.id) || claims.company_id || null;
    this.groupId = dados.groupId || claims.group_id || null;
    if (this.empresaPedida && this.companyId && this.companyId !== this.empresaPedida) {
      throw new PararScript(`O login de ${this.rotulo} entrou na empresa ${this.companyId}, não na pedida (${this.empresaPedida}). Confira o vínculo do usuário.`);
    }
    return this;
  }

  /** Passo de segurança (MFA recente) com código TOTP verdadeiro: digitado (HOMO_*_MFA_CODE) ou gerado do segredo de teste. */
  async confirmarMfa() {
    if (!this.temMfa) throw new PararScript(`A API exigiu MFA recente para ${this.rotulo}. Informe HOMO_*_MFA_CODE (código do aplicativo) ou HOMO_*_MFA_SECRET (segredo TOTP do usuário de teste) e rode de novo.`);
    const tentativas = this.segredoMfa ? 2 : 1;
    for (let i = 0; i < tentativas; i += 1) {
      const codigo = this.segredoMfa ? gerarCodigoTotp(this.segredoMfa) : this.codigoMfa;
      const r = await this.chamar('POST', '/users/me/mfa/verify', { code: codigo }, { semMfaAutomatico: true });
      if (r.status < 300) { this.mfaFeito = true; return; }
      // Código da janela atual já usado (replay) ou no limite da janela: espera o próximo e tenta UMA vez mais.
      if (this.segredoMfa && i + 1 < tentativas) await dormir((segundosParaProximaJanela() + 1) * 1000);
      else throw new PararScript(`O código MFA de ${this.rotulo} foi recusado (HTTP ${r.status}${r.erro ? ` ${r.erro.code}` : ''}). Gere um código novo e rode de novo.`);
    }
  }

  async chamar(metodo, rota, corpo, opcoes = {}) {
    const cabecalhos = { Accept: 'application/json' };
    if (corpo !== undefined) cabecalhos['Content-Type'] = 'application/json';
    if (this.token && !opcoes.semToken) cabecalhos.Authorization = `Bearer ${this.token}`;
    if (opcoes.correlacao) cabecalhos['X-Correlation-Id'] = opcoes.correlacao; // liga a requisição às linhas de auditoria que ela gera
    const res = await fetch(`${this.base}${rota}`, { method: metodo, headers: cabecalhos, body: corpo !== undefined ? JSON.stringify(corpo) : undefined });
    const texto = await res.text();
    let json = null;
    try { json = texto ? JSON.parse(texto) : null; } catch (_) { json = null; }
    const resp = {
      status: res.status, corpo: json, texto, quando: new Date().toISOString(),
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

function lerClaims(token) {
  try { return JSON.parse(Buffer.from(String(token).split('.')[1], 'base64').toString()); } catch (_) { return {}; }
}

module.exports = { Sessao, PararScript, lerBase, dormir, gerarCodigoTotp, BASE_PADRAO };
