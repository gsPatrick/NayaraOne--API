'use strict';

// Verificação independente do Marco 9, rodada 7 (12/11/2026): entrada robusta na API inteira, por mecanismos gerais. Testes de unidade de cada peça:
// forma do pedido (DI-M9R-18), JSON canônico iterativo (DI-M9R-18), resposta de erro segura e proteção do processo (DI-M9R-19), erros de dado do
// banco (DI-M9R-20) e erro de tipo com prova no pedido (DI-M9R-21). Sem banco.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const express = require('express');

const AppError = require('../src/utils/AppError');
const errorHandler = require('../src/middlewares/errorHandler');
const { inspecionarForma, limitesDaForma, PADRAO } = require('../src/middlewares/requestShape.middleware');
const { canonicalJson } = require('../src/utils/canonicalJson');
const { bodyHash } = require('../src/features/core-governance/api-governance/standards/idempotency.hash');
const { limitarDetalhes, CORTADO } = require('../src/middlewares/errorHandler.safe');
const { mapClientDataDbError } = require('../src/middlewares/dbClientErrors');
const { mapClientTypeError, mapInvalidValueError, mapOperatorTypeError, mapFindByPkError } = require('../src/middlewares/clientTypeErrors');
const { installProcessGuards } = require('../src/utils/processGuards');

const aninhadoObj = (n) => JSON.parse(`${'{"a":'.repeat(n)}1${'}'.repeat(n)}`);
const aninhadoLista = (n) => JSON.parse(`${'['.repeat(n)}1${']'.repeat(n)}`);

test('forma: profundidade, quantidade de valores e número finito, sem recursão', () => {
  assert.deepEqual(PADRAO, { maxDepth: 64, maxNodes: 500000 });
  assert.equal(inspecionarForma(aninhadoObj(64)), null, '64 níveis passam');
  assert.deepEqual(inspecionarForma(aninhadoObj(65)), { motivo: 'profundidade', campo: 'a' });
  assert.deepEqual(inspecionarForma({ ok: 1, value: aninhadoLista(500000) }), { motivo: 'profundidade', campo: 'value' }, '500 mil níveis: sem estouro de pilha');
  assert.deepEqual(inspecionarForma(aninhadoLista(65)), { motivo: 'profundidade', campo: '0' });
  assert.deepEqual(inspecionarForma({ x: new Array(600000).fill(0) }), { motivo: 'tamanho', campo: 'x' });
  assert.equal(inspecionarForma({ x: new Array(400000).fill(0) }), null);
  assert.deepEqual(inspecionarForma({ amount: JSON.parse('1e400') }), { motivo: 'numero', campo: 'amount' });
  assert.deepEqual(inspecionarForma({ a: { b: [1, JSON.parse('-1e400')] } }), { motivo: 'numero', campo: 'a' });
  assert.equal(inspecionarForma({ a: 1e308, b: -0, c: JSON.parse("9007199254740993"), d: Buffer.alloc(10) }), null, 'número finito (mesmo grande) passa; Buffer não é percorrido');
  assert.deepEqual(limitesDaForma({ REQUEST_BODY_MAX_DEPTH: '10', REQUEST_BODY_MAX_NODES: '2000' }), { maxDepth: 10, maxNodes: 2000 });
  assert.deepEqual(limitesDaForma({ REQUEST_BODY_MAX_DEPTH: '3', REQUEST_BODY_MAX_NODES: 'x' }), PADRAO, 'fora da faixa ou inválido: o padrão');
});

test('JSON canônico: iterativo (500 mil níveis) e com o mesmo texto da versão recursiva', () => {
  const antiga = (v) => {
    if (Array.isArray(v)) return `[${v.map(antiga).join(',')}]`;
    if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${antiga(v[k])}`).join(',')}}`;
    return JSON.stringify(v === undefined ? null : v);
  };
  const casos = [1, 'a', null, [], {}, [1, [2, [3]], {}], { b: 1, a: [undefined, null, { z: undefined }], c: { d: new Date(0) } }, Buffer.from('ab'), { x: '"q"', y: -0, z: 1e-7 }, [() => 1], { f: () => 1 }];
  for (const c of casos) assert.equal(canonicalJson(c), antiga(c));
  assert.throws(() => antiga(aninhadoObj(20000)), RangeError, 'a versão recursiva estoura a pilha');
  assert.equal(canonicalJson(aninhadoObj(500000)).length, 500000 * 5 + 1 + 500000);
  assert.equal(bodyHash({ b: 1, a: aninhadoObj(100000) }), bodyHash({ a: aninhadoObj(100000), b: 1 }));
});

test('details da resposta de erro: igual dentro dos limites, cortado e sem recursão fora deles', () => {
  const normal = { key: 'x', fields: ['a', 'b'], n: 1, ok: true, nada: null };
  assert.equal(limitarDetalhes(normal), normal, 'dentro dos limites: o mesmo objeto');
  assert.equal(limitarDetalhes(undefined), undefined);
  const fundo = limitarDetalhes({ key: 'k', value: aninhadoObj(50000) });
  assert.equal(fundo.key, 'k');
  assert.doesNotThrow(() => JSON.stringify(fundo));
  assert.ok(JSON.stringify(fundo).includes(CORTADO));
  const texto = limitarDetalhes({ t: 'x'.repeat(20000) });
  assert.equal(texto.t.length, 10001);
  assert.deepEqual(limitarDetalhes({ d: new Date(0), b: 10n }), { d: '1970-01-01T00:00:00.000Z', b: '10' });
});

function servidorCom(erro) {
  const app = express();
  app.get('/x', (_req, _res, next) => next(erro()));
  app.use(errorHandler);
  return new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
}
async function pedir(erro) {
  const s = await servidorCom(erro);
  try {
    const r = await fetch(`http://127.0.0.1:${s.address().port}/x`, { signal: AbortSignal.timeout(5000) });
    return { status: r.status, body: await r.json() };
  } finally { s.close(); }
}

test('errorHandler: details de 50 mil níveis responde 400 (antes: a promessa rejeitava e o pedido ficava sem resposta)', async () => {
  const rejeicoes = [];
  const guarda = (e) => rejeicoes.push(e);
  process.on('unhandledRejection', guarda);
  try {
    const r = await pedir(() => AppError.badRequest('O valor deve ser numérico.', 'SETTING_INVALID_VALUE', { key: 'k', value: aninhadoObj(50000) }));
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, 'SETTING_INVALID_VALUE');
    assert.equal(r.body.error.details.key, 'k');
    await new Promise((s) => setImmediate(s));
    assert.deepEqual(rejeicoes, [], 'nenhuma promessa rejeitada sem tratamento');
  } finally { process.off('unhandledRejection', guarda); }
});

test('errorHandler: se montar a resposta falhar, sai o 500 mínimo (último recurso), sem lançar', async () => {
  const quebrado = () => { const e = AppError.badRequest('x', 'ALGUM'); Object.defineProperty(e, 'message', { get() { throw new Error('getter quebrado'); } }); return e; };
  const r = await pedir(quebrado);
  assert.equal(r.status, 500);
  assert.equal(r.body.error.code, 'INTERNAL_ERROR');
  assert.match(r.body.error.message, /Informe o código .* ao suporte/);
  // resposta já começada: segue para o Express, que encerra a conexão (nunca lança)
  const res = { headersSent: true };
  let seguiu = null;
  assert.doesNotThrow(() => errorHandler(new Error('x'), { method: 'GET', originalUrl: '/y' }, res, (e) => { seguiu = e; }));
  assert.equal(seguiu.message, 'x');
});

const pg = (code, message, extra = {}) => Object.assign(new Error(message), { name: 'SequelizeDatabaseError', parent: { code, message, ...extra }, ...extra.err });

test('erros de dado do banco (classe 22): 400 com o campo quando se sabe, nunca o valor; 2200H continua 500', () => {
  const longo = pg('22001', 'value too long for type character varying(200)');
  longo.sql = 'INSERT INTO "people"."persons" ("id","group_id","legal_name","person_type") VALUES ($1,$2,$3,$4) RETURNING *;';
  longo.parameters = ['id', 'g', 'x'.repeat(256), 'PF'];
  const a = mapClientDataDbError(longo);
  assert.deepEqual([a.statusCode, a.code, a.details.fields, a.details.maxLength, a.logLevel], [400, 'VALUE_TOO_LONG', ['legalName'], 200, 'warn']);
  assert.ok(!JSON.stringify(a).includes('xxxx'), 'o valor não vai na resposta');
  const upd = pg('22001', 'value too long for type character varying(150)');
  upd.sql = 'UPDATE "people"."persons" SET "preferred_name"=$1,"updated_at"=$2 WHERE "id" = $3';
  upd.parameters = ['🙂'.repeat(151), 'agora', 'id'];
  assert.deepEqual(mapClientDataDbError(upd).details.fields, ['preferredName']);
  const emoji = pg('22001', 'value too long for type character varying(150)');
  emoji.sql = upd.sql; emoji.parameters = ['🙂'.repeat(150), 'agora', 'id'];
  assert.deepEqual(mapClientDataDbError(emoji).details.fields, [], '150 emojis cabem em 150 caracteres: o campo não é apontado');
  assert.deepEqual(Object.values(mapClientDataDbError(pg('22007', 'invalid input syntax for type timestamp with time zone: "Invalid date"'))).slice(0, 2), [400, 'INVALID_DATE_VALUE']);
  assert.equal(mapClientDataDbError(pg('22003', 'numeric field overflow')).code, 'VALUE_TOO_LARGE');
  assert.equal(mapClientDataDbError(pg('22P02', 'invalid input syntax for type integer: "abc"')).code, 'INVALID_FIELD_VALUE');
  const divisao = mapClientDataDbError(pg('22012', 'division by zero'));
  assert.deepEqual([divisao.statusCode, divisao.logLevel], [400, 'error'], 'fora da lista do cliente: 400, mas registrado como erro');
  assert.equal(mapClientDataDbError(pg('2200H', 'reached maximum value of sequence')), null);
  assert.equal(mapClientDataDbError(pg('42883', 'operator does not exist: uuid = integer')), null, '42883 precisa de prova no pedido (clientTypeErrors)');
  assert.equal(mapClientDataDbError(new Error('Argument passed to findByPk is invalid: [object Object]')), null, 'findByPk precisa de prova no pedido (clientTypeErrors)');
  assert.equal(mapFindByPkError(new Error('Argument passed to findByPk is invalid: [object Object]'), { body: { personId: { x: 1 } } }).code, 'INVALID_ID_FORMAT');
  assert.equal(mapFindByPkError(new Error('Argument passed to findByPk is invalid: [object Object]'), { body: { personId: 'x' } }), null, 'sem prova: falha do código');
  assert.equal(mapClientDataDbError(new Error('qualquer outra coisa')), null);
});

test('integridade (classe 23): identificador inexistente, obrigatório ausente, CHECK e uso em outro cadastro viram 4xx com a coluna, sem o valor', () => {
  const fk = pg('23503', 'insert or update on table "x" violates foreign key constraint', { detail: 'Key (person_id)=(9d3b6a0e-0000-4000-8000-000000000001) is not present in table "persons".' });
  fk.sql = 'INSERT INTO "people"."person_contacts" ("id","person_id") VALUES ($1,$2)';
  const a = mapClientDataDbError(fk);
  assert.deepEqual([a.statusCode, a.code, a.details.fields, a.logLevel], [400, 'REFERENCE_NOT_FOUND', ['personId'], 'error']);
  assert.ok(!JSON.stringify(a).includes('9d3b6a0e'), 'o id do detalhe do banco não vai na resposta');
  const usado = mapClientDataDbError(pg('23503', 'update or delete on table "persons" violates foreign key constraint', { detail: 'Key (id)=(abc) is still referenced from table "x".' }));
  assert.deepEqual([usado.statusCode, usado.code], [409, 'RECORD_IN_USE']);
  const nulo = pg('23502', 'null value in column "legal_name" violates not-null constraint', { column: 'legal_name' });
  nulo.sql = 'INSERT INTO "people"."persons" ("id") VALUES ($1)';
  assert.deepEqual([mapClientDataDbError(nulo).code, mapClientDataDbError(nulo).details.fields], ['REQUIRED_FIELD_MISSING', ['legalName']]);
  assert.equal(mapClientDataDbError(pg('23514', 'new row violates check constraint "x_ck"')).code, 'INVALID_FIELD_VALUE');
  assert.equal(mapClientDataDbError(pg('23P01', 'conflicting key value violates exclusion constraint')).statusCode, 409);
});

test('42883 (número comparado com texto, identificador ou data): 400 só com número ou booleano no pedido', () => {
  const op = (m) => pg('42883', m);
  assert.equal(mapOperatorTypeError(op('operator does not exist: uuid = integer'), { body: { personId: 12345 } }).code, 'INVALID_ID_FORMAT');
  assert.equal(mapOperatorTypeError(op('operator does not exist: character varying = numeric'), { body: { code: 1.5 } }).code, 'INVALID_FIELD_TYPE');
  assert.equal(mapOperatorTypeError(op('operator does not exist: uuid = integer'), { body: { personId: 'x' } }), null, 'sem número no pedido: falha do código');
  assert.equal(mapOperatorTypeError(op('operator does not exist: integer = bigint'), { body: { a: 1 } }), null, 'dois lados numéricos: falha do código');
  assert.equal(mapOperatorTypeError(op('operator does not exist: jsonb ~~ text'), { body: { a: 1 } }), null);
});

test('"Invalid value" do Sequelize: 400 só com valor estruturado no pedido; o campo é apontado pela impressão do valor', () => {
  const a = mapInvalidValueError(new Error('Invalid value { x: 1 }'), { body: { nome: 'a', destinationLocationId: { x: 1 } } });
  assert.deepEqual([a.statusCode, a.code, a.details.fields], [400, 'INVALID_FIELD_TYPE', ['destinationLocationId']]);
  assert.ok(!a.message.includes('x: 1'));
  assert.equal(mapInvalidValueError(new Error('Invalid value { x: 1 }'), { body: { nome: 'a' } }), null, 'sem valor estruturado no pedido: falha do código');
  assert.deepEqual(mapInvalidValueError(new Error('Invalid value [ 1 ]'), { query: { a: { b: '1' } } }).details.fields, [], 'estruturado sem a mesma impressão: 400 sem campo');
});

test('erro de tipo: 400 só com prova no pedido (o campo citado tem o tipo errado); sem prova, continua 500', () => {
  const erro = (m) => new TypeError(m);
  const a = mapClientTypeError(erro('email.toLowerCase is not a function'), { body: { email: { x: 1 } } });
  assert.deepEqual([a.statusCode, a.code, a.details.fields], [400, 'INVALID_FIELD_TYPE', ['email']]);
  assert.deepEqual(mapClientTypeError(erro('(personType || "PF").toUpperCase is not a function'), { body: { personType: 12345 } }).details.fields, ['personType']);
  assert.deepEqual(mapClientTypeError(erro('contact.value.trim is not a function'), { body: { contacts: [{ value: [1] }] } }).details.fields, ['value']);
  assert.deepEqual(mapClientTypeError(erro('items is not iterable'), { body: { items: 7 } }).details.fields, ['items']);
  assert.equal(mapClientTypeError(erro('email.toLowerCase is not a function'), { body: { email: 'texto@x' } }), null, 'o campo é texto: o erro é do código');
  assert.equal(mapClientTypeError(erro('x.toLowerCase is not a function'), { body: { email: {} } }), null, 'nome que o pedido não tem');
  assert.equal(mapClientTypeError(erro('Cannot read properties of undefined (reading \'a\')'), { body: { a: {} } }), null);
  assert.equal(mapClientTypeError(new Error('email.toLowerCase is not a function'), { body: { email: {} } }), null, 'só TypeError');
});

test('proteção do processo (contrato da rodada 8, DI-M9R-23): promessa rejeitada e exceção sem tratamento são registradas e ENCERRAM o processo', async () => {
  // Na rodada 7 a API seguia atendendo; a rodada 8 mostrou o estado corrompido que isso deixa (transação aberta, trava presa, pool esgotado).
  // O encerramento completo (servidor, prazo, pool, processo de verdade) está em test/entradaGlobal.processo.test.js.
  require('../src/utils/processGuards')._reiniciarParaTeste();
  const proc = new EventEmitter();
  proc.stdout = { write: (_t, cb) => cb() };
  const registros = [];
  const saidas = [];
  const log = { error: (o, m) => registros.push(['error', o.code, m]), fatal: (o, m) => registros.push(['fatal', o.code, m]) };
  assert.equal(installProcessGuards({ log, proc, exit: (c) => saidas.push(c) }), true);
  assert.equal(installProcessGuards({ log, proc, exit: (c) => saidas.push(c) }), false, 'uma vez só');
  proc.emit('unhandledRejection', new RangeError('Maximum call stack size exceeded'));
  proc.emit('uncaughtException', new Error('boom'), 'uncaughtException');
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(registros.map((r) => r.slice(0, 2)), [['fatal', 'PROCESS_UNHANDLED_REJECTION'], ['error', 'PROCESS_UNCAUGHT_EXCEPTION'], ['fatal', 'PROCESS_EXIT']]);
  assert.deepEqual(saidas, [1]);
  assert.equal(proc.listenerCount('unhandledRejection'), 1);
  require('../src/utils/processGuards')._reiniciarParaTeste();
});

test('registro do erro: só texto, cortado (nunca percorre objeto do cliente)', () => {
  const { erroParaLog } = require('../src/middlewares/errorHandler.safe');
  assert.deepEqual(Object.keys(erroParaLog(new TypeError('x'))), ['name', 'code', 'message', 'stack']);
  assert.equal(erroParaLog({ message: 'm'.repeat(10000) }).message.length, 4001);
  assert.deepEqual(erroParaLog('texto'), { message: 'texto' });
  assert.doesNotThrow(() => erroParaLog({ get message() { throw new Error('getter'); } }));
});

test('teto da redação da IA: acima de REDACTION_AI_MAX_CHARS recusa antes de começar (400), em texto e em estrutura; o resumo da auditoria não lança', () => {
  const { redactForAi, redactDeepForAi } = require('../src/shared/redaction');
  const { limiteDaRedacaoIa, PADRAO } = require('../src/shared/redaction/aiSize');
  const { sanitizeSummary } = require('../src/features/ai/audit/auditSanitizer');
  assert.equal(PADRAO, 1048576);
  assert.equal(limiteDaRedacaoIa({}), PADRAO);
  assert.equal(limiteDaRedacaoIa({ REDACTION_AI_MAX_CHARS: '70000' }), 70000);
  assert.equal(limiteDaRedacaoIa({ REDACTION_AI_MAX_CHARS: '10' }), PADRAO, 'fora da faixa: o padrão');
  const t0 = Date.now();
  assert.throws(() => redactForAi(`rua${' '.repeat(61)}`.repeat(70000)), (e) => e.code === 'AI_TEXT_TOO_LARGE' && e.statusCode === 400 && e.details.maxChars === PADRAO);
  assert.ok(Date.now() - t0 < 200, 'a recusa vem antes de qualquer regra (sem os segundos do pior caso)');
  assert.throws(() => redactDeepForAi({ a: 'x'.repeat(600000), b: ['y'.repeat(600000)] }), (e) => e.code === 'AI_TEXT_TOO_LARGE', 'a soma da estrutura conta');
  assert.equal(redactForAi('CPF 123.456.789-09 na rua das Flores 123'), 'CPF [REDIGIDO:cpf] na [REDIGIDO:endereco]', 'abaixo do teto: a mesma redação de sempre');
  assert.equal(sanitizeSummary('x'.repeat(PADRAO + 1), 2000), '[REDIGIDO:texto grande demais para o resumo]');
  assert.equal(sanitizeSummary('CPF 123.456.789-09', 2000), 'CPF [REDIGIDO:cpf]');
  // ingestão da base de conhecimento: documento com texto acima do teto é conteúdo recusado (REJECTED), não erro técnico
  const { redigirParaIndice, Stop } = require('../src/features/ai/retrieval/ingestion.pipeline');
  assert.throws(() => redigirParaIndice('x'.repeat(PADRAO + 1)), (e) => e instanceof Stop && e.status === 'REJECTED' && e.code === 'AI_INGEST_TOO_LARGE');
  assert.equal(redigirParaIndice('e-mail joao@exemplo.com'), 'e-mail [REDIGIDO:email]');
});

test('tempos do servidor: keep-alive de 65 s (o padrão de 5 s fazia o pedido que reaproveitava a conexão sair sem resposta), cabeçalhos 1 s acima', () => {
  const { aplicarTemposDoServidor, keepAliveDoAmbiente, PADRAO } = require('../src/utils/httpServerTimeouts');
  assert.equal(PADRAO, 65000);
  const s = aplicarTemposDoServidor({}, {});
  assert.deepEqual([s.keepAliveTimeout, s.headersTimeout], [65000, 66000]);
  assert.equal(keepAliveDoAmbiente({ HTTP_KEEP_ALIVE_TIMEOUT_MS: '120000' }), 120000);
  assert.equal(keepAliveDoAmbiente({ HTTP_KEEP_ALIVE_TIMEOUT_MS: '10' }), PADRAO, 'fora da faixa: o padrão');
  // CONNECT: 404 ROUTE_NOT_FOUND no formato único de erro, como os outros métodos sem rota (antes o Node só fechava a conexão, sem resposta)
  const servidor = new EventEmitter();
  aplicarTemposDoServidor(servidor, {});
  let escrito = '';
  servidor.emit('connect', {}, { end: (t) => { escrito = t; } });
  assert.match(escrito, /^HTTP\/1\.1 404 Not Found\r\n/);
  assert.match(escrito, /"code":"ROUTE_NOT_FOUND".*"traceId":"[0-9a-f-]{36}"/);
});
