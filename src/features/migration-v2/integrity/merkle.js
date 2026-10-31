'use strict';

const crypto = require('node:crypto');

/**
 * Árvore Merkle do lote (M9-D905 §3.2). Folha = SHA-256(0x00 || linha canônica); nó = SHA-256(0x01 || esquerdo || direito); folhas ordenadas pela chave de origem
 * (ordem lexicográfica binária dos bytes); em nível com número ímpar de nós o último sobe sem duplicação. Lote vazio: raiz = SHA-256 da cadeia vazia, marcada `empty`.
 */
const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest();
const LEAF = Buffer.from([0x00]);
const NODE = Buffer.from([0x01]);

const leafHash = (line) => sha256(Buffer.concat([LEAF, Buffer.isBuffer(line) ? line : Buffer.from(line)]));
const nodeHash = (left, right) => sha256(Buffer.concat([NODE, left, right]));
const sortKeys = (keys) => [...keys].sort((a, b) => Buffer.compare(Buffer.from(String(a), 'utf8'), Buffer.from(String(b), 'utf8')));

/** Raiz de folhas já calculadas: [{ key, hash: Buffer }]. Devolve { root (hex), empty, count }. */
function merkleRoot(leaves) {
  if (!leaves.length) return { root: sha256(Buffer.alloc(0)).toString('hex'), empty: true, count: 0 };
  const ordered = [...leaves].sort((a, b) => Buffer.compare(Buffer.from(String(a.key), 'utf8'), Buffer.from(String(b.key), 'utf8')));
  let level = ordered.map((leaf) => leaf.hash);
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) next.push(i + 1 < level.length ? nodeHash(level[i], level[i + 1]) : level[i]);
    level = next;
  }
  return { root: level[0].toString('hex'), empty: false, count: leaves.length };
}

/** Raiz a partir de linhas canônicas: [{ key, line: Buffer }]. */
function rootOfLines(entries) {
  const result = merkleRoot(entries.map((entry) => ({ key: entry.key, hash: leafHash(entry.line) })));
  return result;
}

module.exports = { leafHash, nodeHash, merkleRoot, rootOfLines, sortKeys };
