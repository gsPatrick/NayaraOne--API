'use strict';

// M9-D905 — serialização canônica e árvore Merkle (sem banco): vetor fixo do livro, nulo x vazio, decimal, ordem de leitura, acento e raiz do lote vazio.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const canonical = require('../../../src/features/migration-v2/integrity/canonical');
const merkle = require('../../../src/features/migration-v2/integrity/merkle');

const SCHEMA = [{ field: 'id', type: 'int' }, { field: 'nome', type: 'text' }, { field: 'valor_centavos', type: 'money' }];
const ROWS = [
  { key: '1', values: { id: 1, nome: 'Ana', valor_centavos: 125000 } },
  { key: '2', values: { id: 2, nome: 'João', valor_centavos: 0 } },
  { key: '3', values: { id: 3, nome: null, valor_centavos: 5000 } },
];
const entries = (rows = ROWS, schema = SCHEMA) => rows.map((row) => ({ key: row.key, line: canonical.canonicalLine(schema, row.values) }));
const sha = (...parts) => crypto.createHash('sha256').update(Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p))))).digest();

test('m9d905 vetor de 3 linhas bate com a raiz do exemplo', () => {
  const line2 = canonical.canonicalLine(SCHEMA, ROWS[1].values);
  assert.deepEqual([...line2], [...Buffer.concat([Buffer.from('1:2'), Buffer.from([0x1f]), Buffer.from('5:João'), Buffer.from([0x1f]), Buffer.from('1:0')])], 'prefixo de comprimento em BYTES: "João" ocupa 5');
  const [l1, l2, l3] = entries().map((e) => merkle.leafHash(e.line).toString('hex'));
  assert.equal(l1, '90e5e6b6f88f3f44efb8d655e8d7f2299f05a3e379affc7524deea8c63f235be');
  assert.equal(l2, 'f64b8a21895225f13fe268ded168b460f38125f059a222a37be2085e9f3b958a');
  assert.equal(l3, '3fd9c6990f10c48381bc117cd7b999587032b744d12784f564be87249fd88a5d');
  const n12 = sha(Buffer.from([1]), Buffer.from(l1, 'hex'), Buffer.from(l2, 'hex')).toString('hex');
  assert.equal(n12, 'd763e25ff99ed82d91f7d14e7a50dab75d6dc5b9db4365c6d72b391bc175413b');
  const root = merkle.rootOfLines(entries());
  assert.equal(root.root, '7ba815cf3fc33c071c6ca47513216fe51c2bad1ac8b3fd814ea45c490ae8c9e0');
  assert.equal(root.empty, false);
  assert.equal(root.count, 3);
});

test('m9d905 alteração de 1 centavo muda a raiz', () => {
  const base = merkle.rootOfLines(entries()).root;
  const changed = ROWS.map((row) => (row.key === '2' ? { ...row, values: { ...row.values, valor_centavos: 1 } } : row));
  assert.notEqual(merkle.rootOfLines(entries(changed)).root, base);
  const l2 = merkle.leafHash(entries(changed)[1].line).toString('hex');
  assert.notEqual(l2, 'f64b8a21895225f13fe268ded168b460f38125f059a222a37be2085e9f3b958a', 'a folha da linha 2 mudou');
});

test('m9d905 linha perdida e perda de acento mudam a raiz', () => {
  const base = merkle.rootOfLines(entries()).root;
  assert.notEqual(merkle.rootOfLines(entries(ROWS.slice(0, 2))).root, base, 'linha perdida');
  const joao = ROWS.map((row) => (row.key === '2' ? { ...row, values: { ...row.values, nome: 'Joao' } } : row));
  assert.notEqual(merkle.rootOfLines(entries(joao)).root, base, 'acento perdido');
});

test('m9d905 ordem de leitura não altera a raiz', () => {
  const base = merkle.rootOfLines(entries()).root;
  const shuffled = [ROWS[2], ROWS[0], ROWS[1]];
  assert.equal(merkle.rootOfLines(entries(shuffled)).root, base);
  const keys = ['10', '2', '1', 'b', 'a'];
  const asc = keys.map((key) => ({ key, line: Buffer.from(`k${key}`) }));
  assert.equal(merkle.rootOfLines(asc).root, merkle.rootOfLines([...asc].reverse()).root);
  assert.deepEqual(merkle.sortKeys(keys), ['1', '10', '2', 'a', 'b'], 'ordem lexicográfica binária das chaves');
});

test('m9d905 nulo e cadeia vazia geram folhas diferentes e decimal negativo usa a escala do esquema', () => {
  const nullable = [{ field: 'x', type: 'text' }];
  const empty = canonical.canonicalLine(nullable, { x: '' });
  const nul = canonical.canonicalLine(nullable, { x: null });
  assert.deepEqual([...empty], [...Buffer.from('0:')]);
  assert.deepEqual([...nul], [0x00]);
  assert.notEqual(merkle.leafHash(empty).toString('hex'), merkle.leafHash(nul).toString('hex'));
  const dec = (value, scale) => canonical.serializeValue('decimal', value, scale).toString();
  assert.equal(dec(-12.5, 2), '6:-12.50');
  assert.equal(dec('-0.005', 2), '5:-0.01', 'arredonda para longe do zero como o banco');
  assert.equal(dec('-0.001', 2), '4:0.00', 'zero negativo vira zero');
  assert.equal(dec(1234, 0), '4:1234');
  assert.equal(dec('1e3', 1), '6:1000.0', 'sem expoente');
});

test('m9d905 formato canônico dos demais tipos', () => {
  const ser = (type, value, scale) => canonical.serializeValue(type, value, scale).toString();
  assert.equal(ser('int', '+7'), '1:7');
  assert.equal(ser('int', -3), '2:-3');
  assert.equal(ser('bool', true), '1:1');
  assert.equal(ser('bool', false), '1:0');
  assert.equal(ser('money', 1250001), '7:1250001');
  assert.equal(ser('instant', new Date('2026-10-27T13:05:00Z')), '24:2026-10-27T13:05:00.000Z');
  assert.equal(ser('instant', '2026-10-27T10:05:00-03:00'), '24:2026-10-27T13:05:00.000Z', 'UTC com milissegundos');
  assert.equal(ser('date', '1985-04-12'), '24:1985-04-12T00:00:00.000Z');
  assert.equal(ser('date', new Date('1985-04-12T00:00:00Z')), '24:1985-04-12T00:00:00.000Z');
  assert.equal(ser('text', '  João  '), '5:João', 'trim e NFC: o "ã" decomposto vira o composto');
  assert.equal(ser('text', 'a\u001fb'), '3:a\u001fb', 'o separador dentro do texto não confunde: o comprimento delimita');
  assert.throws(() => canonical.serializeValue('money', 12.5), /centavos inteiros/);
  assert.throws(() => canonical.serializeValue('instant', 'ontem'), /instante/i);
  assert.throws(() => canonical.serializeValue('xpto', 1), /tipo/i);
});

test('m9d905 lote vazio: raiz é o SHA-256 da cadeia vazia, marcada EMPTY', () => {
  const root = merkle.rootOfLines([]);
  assert.equal(root.root, crypto.createHash('sha256').update('').digest('hex'));
  assert.deepEqual([root.empty, root.count], [true, 0]);
});

test('m9d905 número ímpar de nós: o último sobe sem duplicação', () => {
  const lines = ['a', 'b', 'c', 'd', 'e'].map((key) => ({ key, line: Buffer.from(key) }));
  const leaf = (k) => merkle.leafHash(Buffer.from(k));
  const node = (l, r) => sha(Buffer.from([1]), l, r);
  const expected = node(node(node(leaf('a'), leaf('b')), node(leaf('c'), leaf('d'))), leaf('e')).toString('hex');
  assert.equal(merkle.rootOfLines(lines).root, expected);
  assert.equal(merkle.rootOfLines([{ key: 'z', line: Buffer.from('z') }]).root, leaf('z').toString('hex'), 'uma folha só: a raiz é a folha');
});
