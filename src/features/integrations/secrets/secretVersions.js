'use strict';

const { secretNotFound, rotationFailed } = require('./secrets.errors');

/**
 * Máquina de versões de UM segredo (M9-D202), pura: opera sobre o objeto de metadados e nunca guarda valor.
 * Estados: CANDIDATE (gravada, ainda não vale), CURRENT, GRACE (anterior aceita até `revokeAfter`) e REVOKED.
 * Usada pelo driver de arquivo e pelo sandbox do cofre HTTP para as duas se comportarem igual.
 */

const iso = (ms) => new Date(ms).toISOString();
const newMeta = (ref) => ({ ref, current: null, nextVersion: 1, versions: {} });

/** Estado em vigor: GRACE vencida conta como REVOKED (aceita até o instante `revokeAfter`, inclusive). */
function effectiveStatus(v, nowMs) {
  if (v.status === 'GRACE' && nowMs > Date.parse(v.revokeAfter)) return 'REVOKED';
  return v.status;
}

function promote(meta, version, { nowMs, graceMs = 0 }) {
  const v = meta.versions[version];
  if (!v || v.status !== 'CANDIDATE') throw rotationFailed();
  const anterior = meta.current ? meta.versions[meta.current] : null;
  if (anterior) {
    if (graceMs > 0) {
      anterior.status = 'GRACE';
      anterior.revokeAfter = iso(nowMs + graceMs);
    } else {
      anterior.status = 'REVOKED';
      anterior.revokedAt = iso(nowMs);
    }
  }
  v.status = 'CURRENT';
  v.rotatedAt = anterior ? iso(nowMs) : null;
  meta.current = version;
  return version;
}

/** Cria a versão; sem `candidate` ela já vira a corrente (a anterior entra em GRACE ou é revogada). */
function addVersion(meta, { nowMs, expiresAt = null, candidate = false, graceMs = 0 }) {
  const version = meta.nextVersion;
  meta.nextVersion += 1;
  meta.versions[version] = {
    version, status: 'CANDIDATE', createdAt: iso(nowMs), expiresAt: expiresAt ? iso(new Date(expiresAt).getTime()) : null,
    rotatedAt: null, revokeAfter: null, revokedAt: null, purged: false,
  };
  if (!candidate) promote(meta, version, { nowMs, graceMs });
  return version;
}

/** Versão pedida (ou a corrente). Revogada, vencida na graça ou inexistente: 404. */
function resolveVersion(meta, { version, nowMs }) {
  const numero = version === undefined || version === null ? meta.current : Number(version);
  const v = numero ? meta.versions[numero] : null;
  if (!v || effectiveStatus(v, nowMs) === 'REVOKED') throw secretNotFound();
  if (v.status === 'CANDIDATE' && (version === undefined || version === null)) throw secretNotFound();
  return v;
}

function acceptedVersions(meta, nowMs) {
  return Object.values(meta.versions).filter((v) => ['CURRENT', 'GRACE'].includes(effectiveStatus(v, nowMs)));
}

function revoke(meta, version, nowMs) {
  const v = meta.versions[Number(version)];
  if (!v) throw secretNotFound();
  if (v.status === 'CURRENT') throw rotationFailed();
  if (v.status !== 'REVOKED') {
    v.status = 'REVOKED';
    v.revokedAt = iso(nowMs);
  }
  return v;
}

/** Versões revogadas (inclusive graça vencida) cujo valor ainda não foi apagado do armazenamento. */
const toPurge = (meta, nowMs) => Object.values(meta.versions).filter((v) => !v.purged && effectiveStatus(v, nowMs) === 'REVOKED');

function describe(meta, nowMs) {
  const v = resolveVersion(meta, { nowMs });
  return { version: v.version, createdAt: v.createdAt, rotatedAt: v.rotatedAt, expiresAt: v.expiresAt };
}

module.exports = { newMeta, addVersion, promote, resolveVersion, acceptedVersions, revoke, toPurge, describe, effectiveStatus };
