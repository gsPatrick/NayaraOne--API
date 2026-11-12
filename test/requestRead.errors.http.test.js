'use strict';

// Verificação independente do Marco 9, rodada 6 (12/11/2026; DI-M9R-14 e DI-M9R-15): erros da LEITURA do pedido viram 400, 413 ou 415, nunca 500.
// Servidor HTTP real com os MESMOS leitores do app (express.json e express.urlencoded embrulhados por guardBodyReader), a mesma porta de texto
// (rejectUnstorableText) e o MESMO errorHandler; as rotas de teste só devolvem o corpo. Cobre cada `type` do body-parser e do raw-body, a descompressão
// quebrada, o escape `%` malformado no caminho e o texto que o banco não grava. Sem banco. A versão de cada rota da API real está em
// crm.messages.entrada.robusta.http.test.js.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const zlib = require('node:zlib');
const express = require('express');
const errorHandler = require('../src/middlewares/errorHandler');
const { guardBodyReader, mapBodyReaderError } = require('../src/middlewares/requestRead.errors');
const { rejectUnstorableText } = require('../src/middlewares/storableText.middleware');

let servidor;
let porta;
before(async () => {
  const app = express();
  // middleware que lê o corpo antes do leitor (falha de montagem: stream.encoding.set)
  app.use('/encoding-ja-definido', (req, _res, next) => { req.setEncoding('utf8'); next(); });
  app.use(guardBodyReader(express.json({ limit: '1kb', verify: (req, _res, buf) => { if (buf.includes('RECUSAR-NO-VERIFY')) throw new Error('verify'); } })));
  app.use(guardBodyReader(express.urlencoded({ extended: true, parameterLimit: 5, depth: 2 })));
  app.use(rejectUnstorableText);
  app.all('/eco/:id', (req, res) => res.json({ id: req.params.id, body: req.body, query: req.query }));
  app.all('/encoding-ja-definido', (req, res) => res.json({ ok: true }));
  app.use(errorHandler);
  servidor = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  porta = servidor.address().port;
});
after(() => new Promise((resolve) => { servidor.closeAllConnections(); servidor.close(resolve); }));

/** Pedido cru: `corpo` Buffer ou texto; `declarado` sobrescreve o Content-Length; `cortar` encerra a conexão no meio do corpo. */
function pedir(method, caminho, { headers = {}, corpo, declarado, cortar = false } = {}) {
  return new Promise((resolve) => {
    const buf = corpo === undefined ? null : Buffer.isBuffer(corpo) ? corpo : Buffer.from(corpo);
    const h = { ...headers };
    if (buf) h['Content-Length'] = declarado ?? buf.length;
    const req = http.request({ host: '127.0.0.1', port: porta, method, path: caminho, headers: h }, (res) => {
      const partes = [];
      res.on('data', (c) => partes.push(c));
      res.on('end', () => { let json = null; try { json = JSON.parse(Buffer.concat(partes).toString('utf8')); } catch (_e) { json = null; } resolve({ status: res.statusCode, json }); });
    });
    req.on('error', (e) => resolve({ status: 0, erro: e.code }));
    if (buf && cortar) { req.write(buf.subarray(0, Math.floor(buf.length / 2))); setTimeout(() => req.destroy(), 100); return; }
    if (buf) req.write(buf);
    req.end();
  });
}

const J = { 'Content-Type': 'application/json' };
const codigo = (r) => (r.json && r.json.error ? r.json.error.code : null);

test('corpo que não é JSON utilizável: charset e compressão não aceitos dão 415; corpo comprimido quebrado dá 400; nunca 500', async () => {
  const valido = JSON.stringify({ a: 1 });
  const casos = [
    ['charset latin1', { 'Content-Type': 'application/json; charset=latin1' }, valido, 415, 'REQUEST_BODY_CHARSET_UNSUPPORTED'],
    ['charset inexistente', { 'Content-Type': 'application/json; charset=nao-existe' }, valido, 415, 'REQUEST_BODY_CHARSET_UNSUPPORTED'],
    ['formulário em charset inexistente', { 'Content-Type': 'application/x-www-form-urlencoded; charset=nao-existe' }, 'a=1', 415, 'REQUEST_BODY_CHARSET_UNSUPPORTED'],
    ['gzip quebrado', { ...J, 'Content-Encoding': 'gzip' }, Buffer.from('isto não é gzip'), 400, 'REQUEST_BODY_DECOMPRESSION_FAILED'],
    ['deflate quebrado', { ...J, 'Content-Encoding': 'deflate' }, Buffer.from('isto não é deflate'), 400, 'REQUEST_BODY_DECOMPRESSION_FAILED'],
    ['gzip cortado no meio', { ...J, 'Content-Encoding': 'gzip' }, zlib.gzipSync(valido).subarray(0, 12), 400, 'REQUEST_BODY_DECOMPRESSION_FAILED'],
    ['Content-Encoding br', { ...J, 'Content-Encoding': 'br' }, zlib.brotliCompressSync(valido), 415, 'REQUEST_BODY_ENCODING_UNSUPPORTED'],
    ['Content-Encoding desconhecido', { ...J, 'Content-Encoding': 'x-nada' }, valido, 415, 'REQUEST_BODY_ENCODING_UNSUPPORTED'],
    ['JSON malformado (contrato mantido)', J, '{"a":', 400, 'INVALID_JSON_BODY'],
    ['corpo acima do limite (contrato mantido)', J, JSON.stringify({ a: 'x'.repeat(2000) }), 400, 'FILE_UPLOAD_TOO_LARGE'],
    ['verificação do corpo recusada', J, '{"a":"RECUSAR-NO-VERIFY"}', 400, 'INVALID_REQUEST_BODY'],
    ['formulário com campos demais', { 'Content-Type': 'application/x-www-form-urlencoded' }, 'a=1&b=2&c=3&d=4&e=5&f=6&g=7', 413, 'REQUEST_BODY_TOO_MANY_PARAMETERS'],
    ['formulário fundo demais', { 'Content-Type': 'application/x-www-form-urlencoded' }, 'a[b][c][d][e]=1', 400, 'INVALID_REQUEST_BODY'],
  ];
  const fora = [];
  for (const [nome, headers, corpo, status, code] of casos) {
    const r = await pedir('POST', '/eco/1', { headers, corpo });
    if (r.status !== status || codigo(r) !== code) fora.push(`${nome}: ${r.status} ${codigo(r)} (esperado ${status} ${code})`);
  }
  assert.deepEqual(fora, []);
  // controle: gzip e deflate válidos são lidos normalmente
  for (const [enc, f] of [['gzip', zlib.gzipSync], ['deflate', zlib.deflateSync]]) {
    const r = await pedir('POST', '/eco/1', { headers: { ...J, 'Content-Encoding': enc }, corpo: f(valido) });
    assert.deepEqual([r.status, r.json.body], [200, { a: 1 }], enc);
  }
});

test('corpo interrompido e leitor montado errado: 400 com o código do leitor, e o servidor segue respondendo', async () => {
  const cortado = await pedir('POST', '/eco/1', { headers: J, corpo: JSON.stringify({ a: 'x'.repeat(500) }), cortar: true });
  assert.ok(cortado.status === 0 || cortado.status === 400, `corpo cortado: ${cortado.status}`);
  const r = await pedir('POST', '/encoding-ja-definido', { headers: J, corpo: '{"a":1}' });
  assert.deepEqual([r.status, codigo(r)], [400, 'REQUEST_BODY_UNREADABLE']);
  assert.equal((await pedir('GET', '/eco/1')).status, 200, 'o servidor continua de pé');
  // os tipos que um pedido HTTP não produz de forma confiável, direto no mapeamento
  assert.deepEqual(mapBodyReaderError({ type: 'request.aborted', status: 400 }), { statusCode: 400, code: 'REQUEST_BODY_ABORTED', message: 'O envio do corpo foi interrompido antes do fim.', logServerSide: false });
  assert.equal(mapBodyReaderError({ type: 'request.size.invalid', status: 400 }).code, 'REQUEST_BODY_SIZE_MISMATCH');
  assert.equal(mapBodyReaderError({ type: 'stream.not.readable', status: 500 }).statusCode, 400);
  assert.equal(mapBodyReaderError({ type: 'stream.not.readable', status: 500 }).logServerSide, true);
  assert.equal(mapBodyReaderError(new Error('outro')), null, 'erro que não veio do leitor não é tocado');
});

test('escape % malformado no caminho dá 400 INVALID_ID_FORMAT; o escape válido continua chegando decodificado', async () => {
  for (const c of ['%E0%A4%A', '%', '%ZZ', '%C0%AF', '%ED%A0%80', 'abc%']) {
    for (const m of ['GET', 'POST', 'PATCH', 'DELETE']) {
      const r = await pedir(m, `/eco/${c}`);
      assert.deepEqual([r.status, codigo(r)], [400, 'INVALID_ID_FORMAT'], `${m} /eco/${c}`);
    }
  }
  const ok = await pedir('GET', '/eco/a%20b');
  assert.deepEqual([ok.status, ok.json.id], [200, 'a b']);
});

test('texto que o banco não grava (caractere nulo, metade solta de par sub-rogado) no corpo, em nome de campo ou na consulta: 400 INVALID_TEXT_CHARACTER com o campo', async () => {
  const casos = [
    ['valor com nulo', '{"nome":"a\\u0000b"}', 'nome'],
    ['valor com metade alta solta', '{"nome":"a\\ud800b"}', 'nome'],
    ['valor com metade baixa solta', '{"nome":"\\udc00"}', 'nome'],
    ['em lista, no fundo', '{"vars":["ok",{"x":["\\u0000"]}]}', 'vars'],
    ['nome de campo com nulo', '{"a\\u0000":1}', 'a\uFFFD'],
    ['texto solto na raiz', '"\\u0000"', null],
  ];
  for (const [nome, corpo, campo] of casos) {
    const r = await pedir('POST', '/eco/1', { headers: J, corpo });
    if (campo === null) { assert.ok([400].includes(r.status), `${nome}: ${r.status}`); continue; }
    assert.deepEqual([r.status, codigo(r)], [400, 'INVALID_TEXT_CHARACTER'], nome);
    assert.deepEqual(r.json.error.details.fields, [campo], nome);
    assert.ok(r.json.error.message.isWellFormed() && !r.json.error.message.includes('\u0000') && !r.json.error.message.includes('b"'), 'nem o valor nem o caractere voltam na mensagem');
  }
  const form = await pedir('POST', '/eco/1', { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, corpo: 'nome=a%00b' });
  assert.deepEqual([form.status, codigo(form)], [400, 'INVALID_TEXT_CHARACTER']);
  const consulta = await pedir('GET', '/eco/1?busca=a%00b');
  assert.deepEqual([consulta.status, codigo(consulta), consulta.json.error.details], [400, 'INVALID_TEXT_CHARACTER', { fields: ['busca'], part: 'query' }]);
  // controle: par sub-rogado completo (emoji) e acentos passam
  const ok = await pedir('POST', '/eco/1', { headers: J, corpo: JSON.stringify({ nome: 'Ação 😀 😀' }) });
  assert.deepEqual([ok.status, ok.json.body.nome], [200, 'Ação 😀 😀']);
});
