'use strict';

const { withWire, AFTER, BEFORE, sleep } = require('./contract.wire');
const { callOp, classifyFailure, attempt, result, opDef, nextKey } = require('./contract.runtime');
const { runHealthCheck } = require('../registry/adapterHealth');

/** Cenários 7 a 10 (M9-D222 3.1): duplicado, resposta malformada, mapeamento de status e health check. */

async function duplicate({ adapter, fixture, ops, state }) {
  const out = [];
  for (const op of ops) {
    const def = opDef(adapter, op);
    if (adapter.supportsIdempotency(op)) {
      const chave = nextKey(`dup-${op}`);
      const a = await attempt(() => callOp(adapter, fixture, op, state, { key: chave }));
      const b = await attempt(() => callOp(adapter, fixture, op, state, { key: chave }));
      out.push(result(7, 'duplicate request', op, a.ok && b.ok && a.value.externalResourceId === b.value.externalResourceId, 'a mesma chave de idempotência criou dois recursos externos'));
    } else if (def.opClass === 'DANGEROUS') {
      const estrategia = def.reconcileStrategy || {};
      const consulta = [estrategia.key, estrategia.reference].some((m) => m && typeof adapter[m] === 'function');
      out.push(result(7, 'duplicate request', op, consulta, 'operação perigosa sem chave de idempotência e sem consulta de reconciliação no adapter'));
    } else out.push(result(7, 'duplicate request', op, true, null)); // operação segura sem chave: repetir é seguro (consulta ou efeito idempotente)
  }
  return out;
}

async function malformed({ adapter, fixture, ops }) {
  const out = [];
  const variantes = [['JSON truncado', { before: BEFORE.truncatedJson() }], ['campo faltando', { after: AFTER.missingField() }], ['tipo errado', { after: AFTER.wrongType() }]];
  for (const op of ops) {
    if ((fixture.noResourceId || []).includes(op) && op === 'verifyWebhook') continue; // a resposta de verifyWebhook é o veredito da assinatura, não um recurso do fornecedor
    for (const [rotulo, fio] of variantes) {
      const r = await attempt(() => callOp(withWire(adapter, op, fio), fixture, op, {}));
      const tratada = !r.ok && r.error instanceof Error && !(r.error instanceof TypeError || r.error instanceof ReferenceError);
      const classe = tratada ? classifyFailure(adapter, r.error, op).class : null;
      out.push(result(8, 'malformed response', op, tratada && classe === 'UNKNOWN', `${rotulo}: esperado erro tratado e classe UNKNOWN, veio ${r.ok ? 'sucesso' : r.error.constructor.name} / ${classe}`));
    }
  }
  return out;
}

async function statusMapping({ adapter, fixture }) {
  const out = [];
  for (const [externo, interno] of Object.entries(fixture.statuses || {})) {
    out.push(result(9, 'status mapping', null, adapter.mapStatus(externo) === interno, `${externo}: esperado ${interno}, veio ${adapter.mapStatus(externo)}`));
  }
  out.push(result(9, 'status mapping', null, Object.keys(fixture.statuses || {}).length > 0, 'a fixture não documenta nenhum status do fornecedor'));
  const inedito = fixture.unknownStatus || 'STATUS_INEDITO_DO_FORNECEDOR';
  out.push(result(9, 'status mapping', null, adapter.mapStatus(inedito) === null, 'status inédito deveria mapear para null'));
  const r = await attempt(() => adapter.normalizeStatus(inedito));
  out.push(result(9, 'status mapping', null, !r.ok && r.error.code === 'INTEGRATION_STATUS_UNMAPPED', 'status inédito deveria gerar o erro INTEGRATION_STATUS_UNMAPPED'));
  return out;
}

async function health({ adapter, healthTimeoutMs }) {
  const out = [];
  const direto = await attempt(() => adapter.healthCheck(adapter.ctx));
  out.push(result(10, 'health check', null, direto.ok && typeof direto.value.ok === 'boolean', 'healthCheck() lançou ou devolveu formato inválido'));
  const t0 = Date.now();
  const r = await runHealthCheck(adapter, null, null);
  out.push(result(10, 'health check', null, typeof r.ok === 'boolean' && Date.now() - t0 < healthTimeoutMs, `o teste de saúde passou de ${healthTimeoutMs} ms`));
  // Falha e lentidão do fornecedor: o teste de saúde nunca lança e responde ok:false dentro do prazo.
  const curto = Object.create(adapter);
  curto.ctx = { ...adapter.ctx, healthCheckTimeoutMs: 120 };
  for (const [rotulo, impl] of [['lança', async () => { throw new Error('fornecedor fora'); }], ['trava', async () => { await sleep(2000); return { ok: true, latencyMs: 1, detail: 'tarde' }; }]]) {
    curto.healthCheck = impl;
    const t = Date.now();
    const s = await attempt(() => runHealthCheck(curto, null, null));
    out.push(result(10, 'health check', null, s.ok && s.value.ok === false && Date.now() - t < 1500, `health check que ${rotulo} deveria virar ok:false sem lançar`));
  }
  return out;
}

module.exports = { duplicate, malformed, statusMapping, health };
