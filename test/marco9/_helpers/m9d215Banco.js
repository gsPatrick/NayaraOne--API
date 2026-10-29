'use strict';

// Banco programável COM reconciliação (M9-D215): guarda os pagamentos por chave de idempotência (como um banco de verdade, que devolve o mesmo
// pagamento quando a chave se repete) e responde às consultas do motor (por chave, por id e por referência). Falhas injetáveis: o pedido
// chega e a resposta se perde (`recebeEDaTimeout`), o pedido nem chega (`semReceber`) e a consulta falha (`S.consultaFalha`).
const { bancoProgramavel, erroHttp } = require('./m9d214Scripted');

const timeout = () => Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });

function bancoReconciliavel() {
  const Banco = bancoProgramavel({ idempotente: true });
  const S = Banco.S;
  S.pagamentos = new Map();
  S.todos = [];
  S.consultas = [];
  S.porReferencia = new Map();
  S.consultaFalha = null;
  S.consulta404 = false;
  S.aoConsultar = null;
  const criar = (chave) => {
    const pagamento = { id: `p-${S.todos.length + 1}-${Math.random().toString(36).slice(2, 8)}`, status: 'PROCESSING' };
    S.todos.push(pagamento);
    if (chave) S.pagamentos.set(chave, pagamento);
    return pagamento;
  };
  S.registrar = (chave, status = 'PROCESSING') => { const p = criar(chave); p.status = status; return p; };

  Banco.prototype.submitPayment = async function submitPayment(_ctx, request, meta) {
    S.chamadas.push({ op: 'submitPayment', request, meta, em: Date.now() });
    if (S.aoChamar) await S.aoChamar('submitPayment', request, meta);
    const passo = (S.filas.submitPayment && S.filas.submitPayment.length ? S.filas.submitPayment.shift() : null) || {}; // cada passo vale uma vez
    if (passo.erro) throw passo.erro;
    if (passo.semReceber) throw timeout();
    const chave = meta && meta.idempotencyKey;
    const pagamento = (chave && S.pagamentos.get(chave)) || criar(chave);
    if (passo.recebeEDaTimeout) throw timeout();
    return { externalRequestId: null, externalResourceId: pagamento.id, status: pagamento.status };
  };
  const consultar = async (metodo, achar) => {
    S.consultas.push({ metodo });
    if (S.aoConsultar) await S.aoConsultar(metodo);
    if (S.consultaFalha) throw S.consultaFalha;
    if (S.consulta404) throw erroHttp(404);
    const p = achar();
    return p ? { externalResourceId: p.id, status: p.status } : null;
  };
  Banco.prototype.findByIdempotencyKey = function findByIdempotencyKey(_ctx, request) { return consultar('key', () => S.pagamentos.get(request.idempotencyKey)); };
  Banco.prototype.findByReference = function findByReference(_ctx, request) { return consultar('reference', () => S.porReferencia.get(request.aggregateId)); };
  const statusOriginal = Banco.prototype.getPaymentStatus;
  Banco.prototype.getPaymentStatus = function getPaymentStatus(ctx, request, meta) {
    if (S.filas.getPaymentStatus) return statusOriginal.call(this, ctx, request, meta);
    return consultar('status', () => S.todos.find((p) => p.id === request.externalResourceId));
  };
  return Banco;
}

module.exports = { bancoReconciliavel, timeout };
