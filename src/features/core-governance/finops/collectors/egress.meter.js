'use strict';

const logger = require('../../../../utils/logger');

/**
 * Contador de bytes de download (M9-D860 §3.2): cada resposta de exportação, de arquivo ou da API externa soma os bytes enviados num buffer em memória, por
 * empresa e tipo; o coletor de egress despeja o buffer no acúmulo da hora a cada rodada do job (se o processo cair antes, os bytes do intervalo se perdem).
 * Desligado na suíte (NODE_ENV=test) salvo FINOPS_EGRESS_METER_ENABLED=true; FINOPS_EGRESS_METER_DISABLED=true desliga no processo.
 */
const buffer = new Map();

const disabled = () => process.env.FINOPS_EGRESS_METER_DISABLED === 'true' || (process.env.NODE_ENV === 'test' && process.env.FINOPS_EGRESS_METER_ENABLED !== 'true');

function kindOf(req) {
  const url = req.originalUrl || req.url || '';
  if (/\/api-external(\/|$)/.test(url)) return 'api_externa';
  if (/\/exports(\/|$|\?)/.test(url)) return 'exportacoes';
  if (/\/files(\/|$|\?)/.test(url)) return 'arquivos';
  return null;
}

function add(tenant, kind, bytes) {
  if (!tenant || !tenant.companyId || !Number.isFinite(bytes) || bytes <= 0) return;
  const key = `${tenant.groupId}|${tenant.companyId}|${kind}`;
  buffer.set(key, (buffer.get(key) || 0n) + BigInt(Math.trunc(bytes)));
}

async function tenantOf(req) {
  if (req.auth && req.auth.companyId) return { groupId: req.auth.groupId, companyId: req.auth.companyId };
  const { resolveCaller } = require('../../api-governance/consumers/caller');
  const caller = await resolveCaller(req);
  return caller ? caller.tenant : null;
}

/** Middleware global: ao terminar a resposta, conta os bytes enviados (Content-Length, ou o avanço do socket quando a resposta é em pedaços). */
function egressMeterMiddleware(req, res, next) {
  if (disabled() || req.method === 'OPTIONS') return next();
  const kind = kindOf(req);
  if (!kind) return next();
  const startBytes = res.socket ? res.socket.bytesWritten : 0;
  res.once('finish', () => {
    const declared = Number(res.getHeader('content-length'));
    const bytes = Number.isFinite(declared) && declared > 0 ? declared : (res.socket ? res.socket.bytesWritten - startBytes : 0);
    tenantOf(req).then((tenant) => add(tenant, kind, bytes)).catch((err) => logger.warn({ err: err.message }, 'finops.egress.meter.failed'));
  });
  return next();
}

/** Tira do buffer o que é da empresa e devolve [{ kind, bytes }]. */
function takeFor(tenant) {
  const out = [];
  for (const [key, bytes] of [...buffer.entries()]) {
    const [groupId, companyId, kind] = key.split('|');
    if (groupId === tenant.groupId && companyId === tenant.companyId) { out.push({ kind, bytes }); buffer.delete(key); }
  }
  return out;
}

const putBack = (tenant, items) => items.forEach((i) => add(tenant, i.kind, Number(i.bytes)));
const reset = () => buffer.clear();

module.exports = { egressMeterMiddleware, add, takeFor, putBack, reset, kindOf };
