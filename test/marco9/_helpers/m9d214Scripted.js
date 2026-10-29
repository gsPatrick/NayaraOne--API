'use strict';

// Adapters programáveis (M9-D214/D216/D218): trocam o sandbox do fornecedor por respostas e erros em fila, registrando as chamadas.
const { BankAdapter } = require('../../../src/features/integrations/providers/bank/bank.port');
const { MessagingAdapter } = require('../../../src/features/integrations/providers/messaging/messaging.port');
const { classifyHttpError } = require('../../../src/features/integrations/registry/classifyHttpError');

/** Erro como a camada HTTP o entrega: status, código de rede e cabeçalhos. */
function erroHttp(status, { code, headers, message } = {}) {
  const e = new Error(message || `HTTP ${status}`);
  if (status) e.status = status;
  if (code) e.code = code;
  if (headers) e.headers = { get: (k) => headers[String(k).toLowerCase()] ?? null, ...headers };
  return e;
}

function programavel(Port, code, capabilities, { idempotente = false, renovavel = false } = {}) {
  const S = {
    filas: {}, chamadas: [], renovacoes: 0, aoChamar: null,
    reset() { S.filas = {}; S.chamadas = []; S.renovacoes = 0; S.aoChamar = null; },
    fila(op, passos) { S.filas[op] = passos.slice(); },
    proximo(op) { const q = S.filas[op] || []; return q.length > 1 ? q.shift() : q[0]; },
  };
  class Scripted extends Port {
    providerCode() { return code; }

    capabilities() { return capabilities; }

    supportedVersions() { return ['v1']; }

    async healthCheck() { return { ok: true, latencyMs: 1, detail: 'ok' }; }

    classifyError(e) { return classifyHttpError(e); }

    mapStatus(s) { return s == null ? null : String(s).toUpperCase(); }

    supportsIdempotency() { return idempotente; }

    extractQuota(resposta, now) { return S.quota ? S.quota() : super.extractQuota(resposta, now); }

    async executar(op, request, meta) {
      S.chamadas.push({ op, request, meta, em: Date.now() });
      if (S.aoChamar) await S.aoChamar(op, request, meta);
      const passo = S.proximo(op) || { resposta: { status: 'OK', externalResourceId: `ext-${op}` } };
      if (passo.erro) throw passo.erro;
      return { externalRequestId: null, ...passo.resposta };
    }
  }
  capabilities.forEach((op) => { Scripted.prototype[op] = function chamar(_ctx, request, meta) { return this.executar(op, request, meta); }; });
  if (renovavel) {
    Scripted.prototype.renewCredential = async function renovar() {
      S.renovacoes += 1;
      if (S.falharRenovacao) throw new Error('renovação recusada');
      return { newValue: `token-renovado-${S.renovacoes}`, expiresAt: null };
    };
  }
  Scripted.S = S;
  return Scripted;
}

const BANK_CAPS = ['submitPayment', 'getPaymentStatus', 'getStatement', 'verifyWebhook'];
const MSG_CAPS = ['sendText', 'sendTemplate', 'sendMedia', 'getStatus'];
const bancoProgramavel = (opts) => programavel(BankAdapter, 'bank-sandbox', BANK_CAPS, opts);
const mensagemProgramavel = (opts) => programavel(MessagingAdapter, 'messaging-sandbox', MSG_CAPS, opts);

module.exports = { erroHttp, programavel, bancoProgramavel, mensagemProgramavel };
