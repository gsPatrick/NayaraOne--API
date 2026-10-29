'use strict';

const crypto = require('node:crypto');
const { BLOCKING_SEVERITIES } = require('./depaudit.constants');
const { exceptionState } = require('./depaudit.exceptions');

const GHSA_RE = /GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}/i;

/** Avisos de gravidade high/critical do JSON de `npm audit --json` (formato 2): um item por aviso e pacote vulnerável. */
function parseAuditReport(report) {
  const achados = new Map();
  for (const [nome, v] of Object.entries(report?.vulnerabilities || {})) {
    for (const via of Array.isArray(v.via) ? v.via : []) {
      if (!via || typeof via !== 'object' || !BLOCKING_SEVERITIES.includes(via.severity)) continue;
      const ghsa = (String(via.url || '').match(GHSA_RE) || [null])[0];
      const id = ghsa ? ghsa.toUpperCase() : String(via.source);
      const pacote = via.name || nome;
      achados.set(`${id}|${pacote}`, { id, source: String(via.source), package: pacote, affected: nome, severity: via.severity, title: via.title || 'sem título', url: via.url || null, range: via.range || null });
    }
  }
  return [...achados.values()].sort((a, b) => (a.package + a.id < b.package + b.id ? -1 : 1));
}

const up = (v) => String(v).trim().toUpperCase();
const casa = (e, a) => [up(a.id), up(a.source)].includes(up(e.id)) && [up(a.package), up(a.affected)].includes(up(e.package));

/**
 * Cruza os avisos com as exceções. `blocking`: sem exceção VALID (inclui a vencida e a de validade acima do máximo, com o motivo).
 * `excepted`: liberados por exceção válida. `problems`: exceções que não valem, para o relatório.
 */
function evaluateAudit({ advisories, exceptions = [], now = new Date(), maxDays = 30 }) {
  const estados = exceptions.map((e) => ({ exception: e, ...exceptionState(e, { now, maxDays }) }));
  const blocking = [];
  const excepted = [];
  for (const a of advisories) {
    const doAviso = estados.filter((s) => casa(s.exception, a));
    const valida = doAviso.find((s) => s.state === 'VALID');
    if (valida) excepted.push({ ...a, exception: valida.exception });
    else blocking.push({ ...a, exceptionProblem: doAviso.length ? doAviso.map((s) => `${s.state}: ${s.reason}`).join('; ') : null });
  }
  return { blocking, excepted, problems: estados.filter((s) => s.state !== 'VALID') };
}

/** UUID estável por aviso e pacote: o mesmo aviso reaparecendo cai no mesmo grupo do registro de erros. */
function advisoryRefId(a) {
  const h = crypto.createHash('sha256').update(`${a.id}|${a.package}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

module.exports = { parseAuditReport, evaluateAudit, advisoryRefId };
