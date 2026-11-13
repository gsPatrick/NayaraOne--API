'use strict';
/**
 * Redação dos valores secretos da captura do fechamento do Marco 4 (corpo enviado, corpo recebido, cabeçalhos e rota).
 *
 * Defeito corrigido (verificação independente do Marco 4, partes 1 e 2, 11/11/2026): o `impactToken` da confirmação de ação de nível 3
 * (token ASSINADO de duas partes, `base64url(json).assinatura`) saía sem redação em 12 evidências, porque a redação só conhecia as chaves de
 * credencial e o JWT de três partes. Agora sai redigido:
 *   - por CHAVE: credenciais, segredos e qualquer chave terminada em token/assinatura (impactToken, confirmationToken, x-impact-token,
 *     x-webhook-signature...), em qualquer nível;
 *   - por VALOR: JWT (três partes) e token assinado de duas partes cujo primeiro segmento é JSON em base64url (`eyJ...`), em qualquer texto;
 *   - na ROTA: parâmetro de consulta com nome de token/assinatura.
 * O código digitado da confirmação (`typedCode`) não é segredo (aparece na tela para a pessoa digitar) e continua visível.
 */
const REDACTED = '[REDACTED]';
const CHAVES_SECRETAS = /^(accessToken|refreshToken|token|password|passwordHash|senha|secret|secretEncrypted|webhookSecret|otpauthUri|otpauthUrl|recoveryCodes|contentBase64|mfaSecret|totpSecret|apiKey)$/i;
const CHAVE_TOKEN = /(token|signature|assinatura)$/i;
const JWT_RE = /eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g;
const ASSINADO_RE = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{16,}/g;
const QUERY_TOKEN_RE = /([?&][^=&#]*(?:token|signature|assinatura)[^=&#]*=)[^&#]*/gi;

const ehSecreta = (k) => CHAVES_SECRETAS.test(k) || CHAVE_TOKEN.test(k);

function redigirTexto(s) {
  return s.replace(JWT_RE, REDACTED).replace(ASSINADO_RE, REDACTED).replace(QUERY_TOKEN_RE, `$1${REDACTED}`);
}

function redigirFundo(valor) {
  if (valor === null || valor === undefined) return valor;
  if (typeof valor === 'string') return redigirTexto(valor);
  if (Array.isArray(valor)) return valor.map(redigirFundo);
  if (typeof valor === 'object' && !(valor instanceof Date)) {
    const out = {};
    for (const [k, v] of Object.entries(valor)) {
      if (ehSecreta(k) && v !== null && v !== undefined && (typeof v !== 'object' || Array.isArray(v))) out[k] = REDACTED;
      else out[k] = redigirFundo(v);
    }
    return out;
  }
  return valor;
}

/**
 * Varre um documento (já serializado ou objeto) procurando segredo que escapou: decodifica cada segmento base64/base64url que pareça
 * JSON e procura chaves e padrões de token também no texto decodificado. Devolve a lista de achados ({ caminho, motivo }).
 */
function acharSegredos(doc) {
  const achados = [];
  const decodificar = (s) => {
    const out = [];
    for (const m of s.matchAll(/[A-Za-z0-9_+/-]{16,}={0,2}/g)) {
      try {
        const txt = Buffer.from(m[0].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
        if (/^[\x20-\x7e\s]+$/.test(txt) && /[{":]/.test(txt)) out.push(txt);
      } catch (_) { /* não é base64 */ }
    }
    return out;
  };
  const textoTemToken = (s) => new RegExp(JWT_RE.source).test(s) || new RegExp(ASSINADO_RE.source).test(s);
  const visitar = (v, caminho) => {
    if (v === null || v === undefined) return;
    if (typeof v === 'string') {
      if (textoTemToken(v)) achados.push({ caminho, motivo: 'token assinado/JWT no texto' });
      for (const dec of decodificar(v)) {
        if (/"(k|acao|action)"\s*:/.test(dec) && /"(h|hash)"\s*:/.test(dec)) achados.push({ caminho, motivo: 'base64 decodificado contém payload de token de confirmação' });
        else if (textoTemToken(dec)) achados.push({ caminho, motivo: 'token dentro de texto base64' });
      }
      return;
    }
    if (Array.isArray(v)) { v.forEach((x, i) => visitar(x, `${caminho}[${i}]`)); return; }
    if (typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        if (ehSecreta(k) && typeof x === 'string' && x !== REDACTED && !/omitid|REDACTED|não|sem /i.test(x)) achados.push({ caminho: `${caminho}.${k}`, motivo: `chave secreta "${k}" com valor` });
        visitar(x, `${caminho}.${k}`);
      }
    }
  };
  visitar(typeof doc === 'string' ? JSON.parse(doc) : doc, '$');
  return achados;
}

module.exports = { REDACTED, redigirFundo, redigirTexto, acharSegredos };
