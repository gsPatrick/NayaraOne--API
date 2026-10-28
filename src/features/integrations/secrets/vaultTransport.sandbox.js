'use strict';

const versions = require('./secretVersions');

/**
 * Cofre HTTP de mentira, determinístico e em memória (M9-D202 3.1b: "adapter com sandbox determinístico").
 * Fala o mesmo contrato do transporte real e usa a mesma máquina de versões do driver de arquivo. Serve a testes e
 * ao ambiente SANDBOX; nada fica em disco e o conteúdo some com o processo.
 */
function createSandboxTransport({ clock = () => new Date() } = {}) {
  const segredos = new Map(); // ref -> { meta, valores: Map<versão, texto> }
  const erro = (status) => Object.assign(new Error(`sandbox ${status}`), { status });
  const agora = () => clock().getTime();

  function purgar(s) {
    versions.toPurge(s.meta, agora()).forEach((v) => { s.valores.delete(v.version); v.purged = true; });
  }
  const achar = (ref) => {
    const s = segredos.get(ref);
    if (!s) throw erro(404);
    return s;
  };
  const traduz = (fn) => {
    try { return fn(); } catch (err) {
      if (err.statusCode === 404) throw erro(404);
      if (err.statusCode) throw erro(err.statusCode);
      throw err;
    }
  };
  const entrega = (s, v) => ({ value: s.valores.get(v.version), version: v.version, expiresAt: v.expiresAt });

  const rotas = [
    ['GET', /^\/secrets\/([^/]+)\/versions\/(current|\d+)$/, ([ref, n]) => traduz(() => {
      const s = achar(ref);
      const v = versions.resolveVersion(s.meta, { version: n === 'current' ? undefined : Number(n), nowMs: agora() });
      return entrega(s, v);
    })],
    ['GET', /^\/secrets\/([^/]+)\/accepted$/, ([ref]) => {
      const s = achar(ref);
      return versions.acceptedVersions(s.meta, agora()).map((v) => entrega(s, v));
    }],
    ['GET', /^\/secrets\/([^/]+)\/meta$/, ([ref]) => traduz(() => versions.describe(achar(ref).meta, agora()))],
    ['POST', /^\/secrets\/([^/]+)\/versions$/, ([ref], body) => {
      if (!segredos.has(ref)) segredos.set(ref, { meta: versions.newMeta(ref), valores: new Map() });
      const s = segredos.get(ref);
      const version = versions.addVersion(s.meta, { nowMs: agora(), expiresAt: body.expiresAt, candidate: body.candidate, graceMs: body.graceMs });
      s.valores.set(version, body.value);
      purgar(s);
      return { version };
    }],
    ['POST', /^\/secrets\/([^/]+)\/promote$/, ([ref], body) => traduz(() => {
      const s = achar(ref);
      versions.promote(s.meta, Number(body.version), { nowMs: agora(), graceMs: body.graceMs });
      purgar(s);
      return { version: Number(body.version) };
    })],
    ['POST', /^\/secrets\/([^/]+)\/revoke$/, ([ref], body) => traduz(() => {
      const s = achar(ref);
      versions.revoke(s.meta, body.version, agora());
      purgar(s);
      return {};
    })],
  ];

  return {
    async request({ method, path, body }) {
      for (const [m, re, fn] of rotas) {
        const achou = m === method ? re.exec(path) : null;
        if (achou) return fn(achou.slice(1).map(decodeURIComponent), body || {});
      }
      throw erro(404);
    },
  };
}

module.exports = { createSandboxTransport };
