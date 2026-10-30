'use strict';

const dados = require('../contract.scenarios.data');
const { requestOf, attempt, provoke, expectKind, result, shapeProblems, isNormalized } = require('./ai.runtime');
const { FINISH_REASONS } = require('./ai.shapes');

/** Cenários 7 a 10 da M9-D222 para os adapters de modelo. */

const MODELO_FALTANDO = 'modelo-que-nao-existe';

async function duplicate({ make, fixture, ops }) {
  const out = [];
  for (const op of ops) {
    const pedido = { ...requestOf(fixture, op), idempotencyKey: `contract-dup-${op}` };
    const a = make(null);
    const b = make(null);
    const [r1, r2] = [await attempt(() => a.adapter[op](pedido)), await attempt(() => b.adapter[op](pedido))];
    const igual = r1.ok && r2.ok && JSON.stringify(r1.value.text ?? r1.value.vectors) === JSON.stringify(r2.value.text ?? r2.value.vectors);
    // No adapter real, a chave de idempotência do pedido chega ao fornecedor (é ela que impede o segundo efeito); chamada de consulta de modelo não cria recurso.
    const chaves = [...a.calls, ...b.calls].filter((c) => c.method === 'POST').map((c) => c.headers['idempotency-key']);
    const enviada = fixture.transport !== 'http' || (chaves.length === 2 && chaves.every((k) => k === pedido.idempotencyKey));
    out.push(result(7, 'duplicate request', op, igual && enviada, `a mesma chave deu respostas diferentes ou não chegou ao fornecedor (${JSON.stringify(chaves)})`));
  }
  return out;
}

async function malformed({ make, fixture, ops }) {
  const out = [];
  const tratado = (r, op) => (r.ok ? shapeProblems(op, r.value).length === 0 : isNormalized(r.error) && !(r.error instanceof TypeError));
  if (fixture.transport === 'http') {
    for (const op of ops) {
      const campos = (fixture.wire[op] && fixture.wire[op].mutations) || {};
      const variantes = [['JSON truncado', { kind: 'truncated' }, true]];
      if (campos.missing) variantes.push(['campo faltando', { kind: 'mutate', how: 'missing', field: campos.missing }, false]);
      if (campos.wrongType) variantes.push(['tipo errado', { kind: 'mutate', how: 'wrongType', field: campos.wrongType }, false]);
      for (const [rotulo, fault, exigeErro] of variantes) {
        const { out: r } = await provoke({ make, fixture, op, fault, kind: 'UNKNOWN' });
        const ok = exigeErro ? !expectKind(r, 'UNKNOWN', false) : tratado(r, op);
        out.push(result(8, 'malformed response', op, ok, `${rotulo}: esperado erro normalizado (UNKNOWN para JSON ilegível) ou resposta válida; veio ${r.ok ? 'resposta fora da forma' : r.error.constructor.name}`));
      }
    }
  }
  // Pedido malformado (em qualquer transporte): modelo desconhecido e entradas de tipo errado viram VALIDATION, nunca exceção solta.
  for (const op of ops) {
    const pedido = { ...requestOf(fixture, op), model: MODELO_FALTANDO };
    const r = await attempt(() => make(null).adapter[op](pedido));
    const problema = expectKind(r, 'VALIDATION', false);
    out.push(result(8, 'malformed response', op, !problema, `modelo desconhecido: ${problema}`));
  }
  if (ops.includes('embed')) {
    const r = await attempt(() => make(null).adapter.embed({ ...requestOf(fixture, 'embed'), inputs: [1, 2] }));
    const problema = expectKind(r, 'VALIDATION', false);
    out.push(result(8, 'malformed response', 'embed', !problema, `entradas de tipo errado: ${problema}`));
  }
  return out;
}

/** Status: o fim de geração documentado mapeia para o interno (fixture.statuses) e o inédito vira null + erro (cenário comum), e cada fim de geração da fixture vira o `finishReason` do formato comum. */
async function statusMapping(args) {
  const { make, fixture, ops } = args;
  const out = await dados.statusMapping({ adapter: make(null).adapter, fixture });
  if (fixture.transport === 'http' && ops.includes('generate')) {
    for (const f of fixture.finishReasons || []) {
      const { adapter } = make({ kind: 'overrideOk', patch: f.set });
      const r = await attempt(() => adapter.generate(requestOf(fixture, 'generate')));
      out.push(result(9, 'status mapping', 'generate', r.ok && r.value.finishReason === f.expect && FINISH_REASONS.includes(r.value.finishReason), `fim ${JSON.stringify(f.set)}: esperado ${f.expect}, veio ${r.ok ? r.value.finishReason : r.error.message}`));
    }
  }
  return out;
}

async function health(args) {
  const { make, fixture } = args;
  const out = await dados.health({ adapter: make(null).adapter, healthTimeoutMs: args.healthTimeoutMs });
  if (fixture.transport === 'http') {
    const { adapter } = make({ kind: 'status', status: 503 });
    const r = await attempt(() => adapter.healthCheck(adapter.ctx));
    out.push(result(10, 'health check', null, r.ok && r.value.ok === false, 'fornecedor fora do ar: o teste de saúde deve responder ok:false sem lançar'));
  }
  return out;
}

module.exports = { duplicate, malformed, statusMapping, health };
