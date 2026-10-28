'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const AppError = require('../../../utils/AppError');
const { SecretValue } = require('./SecretValue');
const { secretNotFound, storeUnavailable, storeConfig } = require('./secrets.errors');
const { assertValue, assertRef } = require('./storeContract');
const { parseMasterKey, encryptValue, decryptValue } = require('./secretCrypto');
const versions = require('./secretVersions');

/**
 * Driver `file-mounted` (M9-D202 3.1a), para DEV e LAB: um diretório montado FORA do repositório, uma pasta por
 * referência (nome = SHA-256 da referência, sem caminho montado a partir de texto do usuário), um arquivo `.enc`
 * 0600 por versão (valor cifrado em repouso) e um `meta.json` só com versões e datas. Escritas atômicas
 * (arquivo temporário + rename) e serializadas por referência dentro do processo.
 */
const REPO_ROOT = path.resolve(__dirname, '../../../..');

function resolverDiretorio(dir) {
  if (!dir || typeof dir !== 'string') throw storeConfig('diretório do cofre ausente (SECRET_STORE_DIR).');
  const resolvido = path.resolve(dir);
  if (resolvido === REPO_ROOT || resolvido.startsWith(REPO_ROOT + path.sep)) {
    throw storeConfig('o diretório do cofre deve ficar FORA do repositório.');
  }
  return resolvido;
}

function createFileMountedStore({ dir, masterKey, clock = () => new Date() } = {}) {
  const raiz = resolverDiretorio(dir);
  const key = parseMasterKey(masterKey);
  const filas = new Map();
  const agora = () => clock().getTime();

  const pastaDe = (ref) => path.join(raiz, crypto.createHash('sha256').update(ref).digest('hex'));
  const arquivoDe = (ref, n) => path.join(pastaDe(ref), `v${n}.enc`);
  const aadDe = (ref, n) => `${ref}#${n}`;

  function gravarAtomico(destino, conteudo) {
    fs.mkdirSync(path.dirname(destino), { recursive: true, mode: 0o700 });
    const temp = `${destino}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    fs.writeFileSync(temp, conteudo, { mode: 0o600 });
    fs.renameSync(temp, destino);
  }

  function lerMeta(ref) {
    const arquivo = path.join(pastaDe(ref), 'meta.json');
    if (!fs.existsSync(arquivo)) return null;
    return JSON.parse(fs.readFileSync(arquivo, 'utf8'));
  }

  const gravarMeta = (ref, meta) => gravarAtomico(path.join(pastaDe(ref), 'meta.json'), JSON.stringify(meta));

  /** Apaga o valor das versões revogadas (inclusive graça vencida) e marca no meta. Devolve se mudou. */
  function purgar(ref, meta) {
    const lista = versions.toPurge(meta, agora());
    lista.forEach((v) => {
      fs.rmSync(arquivoDe(ref, v.version), { force: true });
      v.purged = true;
    });
    return lista.length > 0;
  }

  function embrulhar(fn) {
    return async (...args) => {
      try {
        return await fn(...args);
      } catch (err) {
        if (err instanceof AppError) throw err;
        throw storeUnavailable();
      }
    };
  }

  /** Serializa as operações que escrevem na mesma referência. */
  function comTrava(ref, fn) {
    const anterior = filas.get(ref) || Promise.resolve();
    const atual = anterior.catch(() => {}).then(fn);
    filas.set(ref, atual);
    return atual.finally(() => { if (filas.get(ref) === atual) filas.delete(ref); });
  }

  const lerValor = (ref, v) => {
    const arquivo = arquivoDe(ref, v.version);
    if (!fs.existsSync(arquivo)) throw secretNotFound();
    return decryptValue(fs.readFileSync(arquivo), key, aadDe(ref, v.version));
  };

  const entrega = (ref, v) => ({ value: new SecretValue(lerValor(ref, v)), version: v.version, expiresAt: v.expiresAt ? new Date(v.expiresAt) : null });

  return {
    driver: 'file-mounted',

    get: embrulhar(async (ref, { version } = {}) => {
      assertRef(ref);
      const meta = lerMeta(ref);
      if (!meta) throw secretNotFound();
      const v = versions.resolveVersion(meta, { version, nowMs: agora() });
      const resposta = entrega(ref, v);
      if (versions.toPurge(meta, agora()).length) await comTrava(ref, () => { if (purgar(ref, meta)) gravarMeta(ref, meta); });
      return resposta;
    }),

    getAcceptedVersions: embrulhar(async (ref) => {
      assertRef(ref);
      const meta = lerMeta(ref);
      if (!meta) throw secretNotFound();
      return versions.acceptedVersions(meta, agora()).map((v) => entrega(ref, v));
    }),

    put: embrulhar(async (ref, value, { expiresAt = null, candidate = false, graceMs = 0 } = {}) => {
      assertRef(ref);
      assertValue(value);
      return comTrava(ref, () => {
        const meta = lerMeta(ref) || versions.newMeta(ref);
        const version = versions.addVersion(meta, { nowMs: agora(), expiresAt, candidate, graceMs });
        gravarAtomico(arquivoDe(ref, version), encryptValue(value, key, aadDe(ref, version)));
        purgar(ref, meta);
        gravarMeta(ref, meta);
        return version;
      });
    }),

    rotate: embrulhar(async (ref, version, { graceMs = 0 } = {}) => {
      assertRef(ref);
      return comTrava(ref, () => {
        const meta = lerMeta(ref);
        if (!meta) throw secretNotFound();
        versions.promote(meta, Number(version), { nowMs: agora(), graceMs });
        purgar(ref, meta);
        gravarMeta(ref, meta);
        return Number(version);
      });
    }),

    describe: embrulhar(async (ref) => {
      assertRef(ref);
      const meta = lerMeta(ref);
      if (!meta) throw secretNotFound();
      return versions.describe(meta, agora());
    }),

    revoke: embrulhar(async (ref, version) => {
      assertRef(ref);
      return comTrava(ref, () => {
        const meta = lerMeta(ref);
        if (!meta) throw secretNotFound();
        versions.revoke(meta, version, agora());
        purgar(ref, meta);
        gravarMeta(ref, meta);
      });
    }),
  };
}

module.exports = { createFileMountedStore };
