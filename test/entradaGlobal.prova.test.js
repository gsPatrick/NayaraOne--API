'use strict';

// Verificação independente do Marco 9, rodada 8 (12/11/2026), item 3 (DI-M9R-25): os mecanismos da rodada 7 escondiam defeito do servidor.
// - O guarda genérico de tipo (clientTypeErrors.js) convertia em 400 um erro nascido no código sempre que o pedido trazia um número, um booleano, uma
//   lista ou um campo com o nome da variável. Foi retirado: o tipo dos campos é conferido na porta de cada rota (esquema).
// - As classes 22 e 23 do Postgres viravam 4xx sem prova (divisão por zero, NOT NULL, chave estrangeira e CHECK do servidor), e 22P02, 22001 e 2201B
//   do servidor saíam só como aviso, sem a pilha. Agora 4xx só com prova de que o valor recusado veio do pedido (dbClientErrors.js, provaDoPedido.js).
// Parte 1 (sem banco): a regra de prova de cada código. Parte 2 (banco real, errorHandler real): os defeitos simulados do verificador
// (r8/mecanismos-r8.test.js) dão 500 com o registro de ERRO e a pilha, com qualquer corpo comum; os erros do cliente continuam 4xx, sem o valor.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { mapClientDataDbError, valorCitado } = require('../src/middlewares/dbClientErrors');

const PRECISA_BANCO = process.env.DISPOSABLE_DB === '1' || process.env.CI ? false : 'precisa do banco descartável (node scripts/withDisposableDb.js)';
const pg = (code, message, extra = {}) => Object.assign(new Error(message), { name: 'SequelizeDatabaseError', parent: { code, message, ...extra } });
const pedido = (body = {}, query = {}, params = {}) => ({ body, query, params });

// ---------- parte 1: a regra ----------

test('guarda genérico de tipo retirado: não há mais conversão de TypeError, findByPk, "Invalid value" ou 42883 em 400', () => {
  assert.equal(fs.existsSync(path.join(__dirname, '..', 'src/middlewares/clientTypeErrors.js')), false);
  const fonte = fs.readFileSync(path.join(__dirname, '..', 'src/middlewares/errorHandler.js'), 'utf8');
  assert.doesNotMatch(fonte, /require\('\.\/clientTypeErrors'\)|mapClientTypeError\(|mapFindByPkError\(|mapInvalidValueError\(|mapOperatorTypeError\(/);
  assert.doesNotMatch(fonte, /invalid input syntax for type uuid\/i\.test|numeric field overflow\/i\.test/, 'nem o 400 incondicional do uuid inválido e do overflow');
});

test('classe 22 com valor citado: 400 só quando o valor é de um campo do pedido; o valor nunca volta', () => {
  const uuid = pg('22P02', 'invalid input syntax for type uuid: "abc"');
  assert.deepEqual(mapClientDataDbError(uuid, pedido({}, {}, { id: 'abc' })), { statusCode: 400, code: 'INVALID_ID_FORMAT', message: 'O identificador informado não é válido.', details: { fields: [] } });
  assert.equal(mapClientDataDbError(uuid, pedido({ amount: 10, allowDuplicate: true, items: [1, 2] })), null, 'o "abc" não está no pedido: defeito do servidor');
  const data = pg('22007', 'invalid input syntax for type timestamp with time zone: "amanhã cedo"');
  const r = mapClientDataDbError(data, pedido({ nextActionDueAt: 'amanhã cedo' }));
  assert.deepEqual([r.statusCode, r.code], [400, 'INVALID_DATE_VALUE']);
  assert.ok(!JSON.stringify(r).includes('amanhã'), 'sem o valor');
  assert.equal(mapClientDataDbError(data, pedido({ status: 7 })), null);
  const enumErr = pg('22P02', 'invalid input value for enum feedback_status: "XYZ"');
  assert.equal(mapClientDataDbError(enumErr, pedido({}, { status: 'xyz' })).code, 'INVALID_FIELD_VALUE', 'o serviço passou para maiúsculas: a comparação também');
  const constante = pg('22P02', 'invalid input syntax for type integer: "segredo"');
  assert.equal(mapClientDataDbError(constante, pedido({ amount: 10 })), null, 'constante do código que não converte: 500');
  const grande = pg('22003', 'value "99999999999" is out of range for type integer');
  assert.equal(mapClientDataDbError(grande, pedido({ quantity: 99999999999 })).code, 'VALUE_TOO_LARGE');
  assert.equal(mapClientDataDbError(grande, pedido({ quantity: 1 })), null);
  assert.equal(valorCitado('date/time field value out of range: "2026-02-30"'), '2026-02-30');
});

test('classe 22 com a coluna conhecida pelo comando: o campo do pedido tem de ter o nome da coluna (ou do atributo)', () => {
  const e = pg('22007', 'invalid input syntax for type timestamp with time zone: "xx"');
  e.sql = 'INSERT INTO "crm"."opportunities" ("id","next_action_due_at") VALUES ($1,$2) RETURNING *;';
  e.parameters = ['id', 'xx'];
  assert.deepEqual(mapClientDataDbError(e, pedido({ nextActionDueAt: 'xx' })).details.fields, ['nextActionDueAt']);
  assert.equal(mapClientDataDbError(e, pedido({ notes: 'xx' })), null, 'mesmo valor em outro campo: não liga a coluna ao pedido');
  const vazio = pg('22P02', 'invalid input syntax for type uuid: ""');
  assert.equal(mapClientDataDbError(vazio, pedido({ description: '' })), null, 'valor vazio sem coluna conhecida não é prova');
});

test('22001 e 22003 sem valor na mensagem: pelo parâmetro do comando, ligado ao campo de mesmo nome do pedido', () => {
  const longo = pg('22001', 'value too long for type character varying(200)');
  longo.sql = 'INSERT INTO "people"."persons" ("id","group_id","legal_name","person_type") VALUES ($1,$2,$3,$4) RETURNING *;';
  longo.parameters = ['id', 'g', 'x'.repeat(256), 'PF'];
  const a = mapClientDataDbError(longo, pedido({ legalName: 'x'.repeat(256) }));
  assert.deepEqual([a.statusCode, a.code, a.details.fields, a.details.maxLength], [400, 'VALUE_TOO_LONG', ['legalName'], 200]);
  assert.ok(!JSON.stringify(a).includes('xxxx'));
  assert.equal(mapClientDataDbError(longo, pedido({ legalName: 'curto', amount: 10 })), null, 'texto montado pelo servidor: 500');
  const emoji = pg('22001', 'value too long for type character varying(150)');
  emoji.sql = 'UPDATE "people"."persons" SET "preferred_name"=$1,"updated_at"=$2 WHERE "id" = $3';
  emoji.parameters = ['🙂'.repeat(150), 'agora', 'id'];
  assert.equal(mapClientDataDbError(emoji, pedido({ preferredName: '🙂'.repeat(150) })), null, '150 emojis cabem em 150 caracteres: não é este o valor');
  const cru = pg('22001', 'value too long for type character varying(10)');
  cru.sql = "INSERT INTO t (c) VALUES ('isto é longo demais')";
  assert.deepEqual(mapClientDataDbError(cru, pedido({ v: 'isto é longo demais' })).details.fields, ['v'], 'comando com substituições: o texto do pedido está no comando');
  const estouro = pg('22003', 'numeric field overflow');
  estouro.sql = 'INSERT INTO "inventory"."items" ("id","min_stock") VALUES ($1,$2)';
  estouro.parameters = ['id', '1e30'];
  assert.equal(mapClientDataDbError(estouro, pedido({ amount: 10 })), null, 'sem o valor no pedido: 500');
});

test('classe 23: obrigatório vazio, chave inexistente, em uso, CHECK e conflito só com prova; sem prova é 500', () => {
  const nulo = pg('23502', 'null value in column "legal_name" violates not-null constraint', { column: 'legal_name', table: 'persons' });
  nulo.sql = 'INSERT INTO "people"."persons" ("id","legal_name") VALUES ($1,$2)';
  nulo.parameters = ['id', null];
  assert.deepEqual([mapClientDataDbError(nulo, pedido({ legalName: null })).code, mapClientDataDbError(nulo, pedido({ legalName: '' })).details.fields], ['REQUIRED_FIELD_MISSING', ['legalName']]);
  assert.equal(mapClientDataDbError(nulo, pedido({ allowDuplicate: true })), null, 'NOT NULL esquecido pelo código: 500');
  const fk = pg('23503', 'insert or update on table "person_contacts" violates foreign key constraint', { table: 'person_contacts', detail: 'Key (person_id)=(9d3b6a0e-0000-4000-8000-000000000001) is not present in table "persons".' });
  fk.sql = 'INSERT INTO "people"."person_contacts" ("id","person_id") VALUES ($1,$2)';
  fk.parameters = ['id', '9d3b6a0e-0000-4000-8000-000000000001'];
  const a = mapClientDataDbError(fk, pedido({ personId: '9d3b6a0e-0000-4000-8000-000000000001' }));
  assert.deepEqual([a.statusCode, a.code, a.details.fields], [400, 'REFERENCE_NOT_FOUND', ['personId']]);
  assert.ok(!JSON.stringify(a).includes('9d3b6a0e'));
  assert.equal(mapClientDataDbError(fk, pedido({ amount: 10 })), null, 'identificador do servidor: 500');
  const semDetalhe = pg('23503', 'insert or update violates foreign key constraint', { table: 'bank_transactions', constraint: 'bank_transactions_bank_account_id_fkey' });
  semDetalhe.sql = 'INSERT INTO "finance"."bank_transactions" ("id","bank_account_id") VALUES ($1,$2)';
  semDetalhe.parameters = ['id', 'abc-id'];
  assert.deepEqual(mapClientDataDbError(semDetalhe, pedido({ bankAccountId: 'abc-id' })).details.fields, ['bankAccountId'], 'sem o detalhe (papel sem leitura da tabela): pela restrição e pelo parâmetro');
  const usado = pg('23503', 'update or delete on table "persons" violates foreign key constraint', { detail: 'Key (id)=(abc) is still referenced from table "x".' });
  assert.deepEqual([mapClientDataDbError(usado, pedido({}, {}, { id: 'abc' })).statusCode, mapClientDataDbError(usado, pedido({}, {}, { id: 'abc' })).code], [409, 'RECORD_IN_USE']);
  assert.equal(mapClientDataDbError(usado, pedido({}, {}, { id: 'outro' })), null);
  const check = pg('23514', 'new row violates check constraint', { table: 'items', constraint: 'items_quantity_check' });
  check.sql = 'INSERT INTO "inventory"."items" ("id","quantity") VALUES ($1,$2)';
  check.parameters = ['id', -5];
  assert.equal(mapClientDataDbError(check, pedido({ quantity: -5 })).code, 'INVALID_FIELD_VALUE');
  assert.equal(mapClientDataDbError(check, pedido({ status: 7 })), null);
  assert.equal(mapClientDataDbError(pg('23514', 'new row violates check constraint "x_ck"'), pedido({ a: 1 })), null, 'CHECK sem coluna conhecida: 500');
  const faixa = pg('23P01', 'conflicting key value violates exclusion constraint', { detail: 'Key (unit_id, period)=(u1, [2026-01-01,2026-02-01)) conflicts with existing key (unit_id, period)=(u1, [2026-01-15,2026-03-01)).' });
  assert.equal(mapClientDataDbError(faixa, pedido({ unitId: 'u1' })).statusCode, 409);
  assert.equal(mapClientDataDbError(faixa, pedido({ amount: 10 })), null);
});

test('códigos que nunca são do cliente: 22012, 2201B, 2201W, 2202E, 2200H, 22004', () => {
  for (const [c, m] of [['22012', 'division by zero'], ['2201B', 'invalid regular expression: parentheses () not balanced'], ['2201W', 'LIMIT must not be negative'], ['2202E', 'array size exceeds the maximum allowed'], ['2200H', 'reached maximum value of sequence'], ['22004', 'null value not allowed']]) {
    assert.equal(mapClientDataDbError(pg(c, m), pedido({ a: m, b: -1, c: 0 })), null, c);
  }
});

// ---------- parte 2: os defeitos simulados do verificador, pelo errorHandler real ----------

test('defeito do servidor: 500 e registro de ERRO com a pilha, com qualquer corpo comum; erro do cliente: 4xx sem o valor', { skip: PRECISA_BANCO, timeout: 120000 }, async () => {
  const logger = require('../src/utils/logger');
  const errorHandler = require('../src/middlewares/errorHandler');
  const { sequelize, Person } = require('../src/models');
  const LOGS = [];
  const originais = {};
  for (const nivel of ['error', 'warn', 'fatal']) {
    originais[nivel] = logger[nivel];
    logger[nivel] = function registrar(obj, msg) { LOGS.push({ nivel, msg: msg || '', obj }); return originais[nivel].call(this, obj, msg); };
  }
  after(() => { for (const nivel of Object.keys(originais)) logger[nivel] = originais[nivel]; });
  const SEGREDO = 'segredo-r8-9f3c';
  const app = express();
  app.use(express.json());
  const rota = (p, fn) => app.post(p, async (req, res, next) => { try { await fn(req); res.json({ ok: true }); } catch (e) { next(e); } });
  const naTx = (fn) => sequelize.transaction(async (t) => fn(t));
  rota('/srv/findbypk-objeto', () => Person.findByPk({ id: 'x' }));
  rota('/srv/operador-uuid-inteiro', () => sequelize.query('SELECT 1 FROM people.persons WHERE id = 42 LIMIT 1'));
  rota('/srv/invalid-value', () => Person.findAll({ where: { legalName: { naoEOperador: 1 } }, limit: 1 }));
  rota('/srv/typeerror-mesmo-nome', () => { const status = 7; return status.toUpperCase(); });
  rota('/srv/typeerror-iteravel', () => { const items = 3; return [...items]; });
  rota('/srv/divisao-por-zero', () => sequelize.query('SELECT 1/0'));
  rota('/srv/cast-constante', () => sequelize.query(`SELECT '${SEGREDO}'::int`));
  rota('/srv/uuid-do-servidor', () => sequelize.query(`SELECT '${SEGREDO}'::uuid`));
  rota('/srv/texto-longo-do-servidor', () => naTx(async (t) => { await sequelize.query('CREATE TEMP TABLE r8_t (c varchar(10)) ON COMMIT DROP', { transaction: t }); await sequelize.query(`INSERT INTO r8_t (c) VALUES ('${SEGREDO}-${'x'.repeat(40)}')`, { transaction: t }); }));
  rota('/srv/not-null', () => naTx(async (t) => { await sequelize.query('CREATE TEMP TABLE r8_n (c int NOT NULL) ON COMMIT DROP', { transaction: t }); await sequelize.query('INSERT INTO r8_n (c) VALUES (NULL)', { transaction: t }); }));
  rota('/srv/fk', () => naTx(async (t) => {
    await sequelize.query('CREATE TEMP TABLE r8_p (id int PRIMARY KEY) ON COMMIT DROP', { transaction: t });
    await sequelize.query('CREATE TEMP TABLE r8_f (pid int REFERENCES r8_p(id)) ON COMMIT DROP', { transaction: t });
    await sequelize.query('INSERT INTO r8_f (pid) VALUES (987654)', { transaction: t });
  }));
  rota('/srv/check', () => naTx(async (t) => { await sequelize.query('CREATE TEMP TABLE r8_c (c int CHECK (c > 0)) ON COMMIT DROP', { transaction: t }); await sequelize.query('INSERT INTO r8_c (c) VALUES (-5)', { transaction: t }); }));
  rota('/srv/array-subscript', () => sequelize.query('SELECT array_fill(1, ARRAY[-1])'));
  rota('/srv/regex-invalido', () => sequelize.query("SELECT 'a' ~ '('"));
  rota('/cli/cast', (req) => sequelize.query('SELECT CAST(:v AS int)', { replacements: { v: req.body.v } }));
  rota('/cli/texto-longo', (req) => naTx(async (t) => { await sequelize.query('CREATE TEMP TABLE r8_t2 (c varchar(10)) ON COMMIT DROP', { transaction: t }); await sequelize.query('INSERT INTO r8_t2 (c) VALUES (:v)', { replacements: { v: req.body.v }, transaction: t }); }));
  rota('/cli/uuid', (req) => sequelize.query('SELECT 1 FROM people.persons WHERE id = :v LIMIT 1', { replacements: { v: req.body.v } }));
  app.use(errorHandler);
  const servidor = app.listen(0);
  await new Promise((r) => servidor.once('listening', r));
  after(() => servidor.close());
  const pedir = (caminho, corpo) => new Promise((resolve) => {
    const buf = Buffer.from(corpo);
    const req = http.request({ host: '127.0.0.1', port: servidor.address().port, method: 'POST', path: caminho, headers: { 'Content-Type': 'application/json', 'Content-Length': buf.length } }, (res) => {
      const ch = []; res.on('data', (c) => ch.push(c)); res.on('end', () => { const txt = Buffer.concat(ch).toString(); let j = null; try { j = JSON.parse(txt); } catch (_e) { j = null; } resolve({ status: res.statusCode, code: j && j.error ? j.error.code : null, txt }); });
    });
    req.on('error', (e) => resolve({ status: 0, code: e.message, txt: '' }));
    req.write(buf); req.end();
  });
  // os corpos da sonda do verificador (o que qualquer tela manda) e um que tem os nomes das variáveis e das colunas do código simulado
  const CORPOS = ['{}', '{"amount": 10}', '{"allowDuplicate": true}', '{"items": [1, 2]}', '{"status": 7}', '{"items": 3}', '{"c": null, "pid": 1, "id": "x", "legalName": [1]}'];
  const falhas = [];
  for (const caso of app._router.stack.filter((l) => l.route).map((l) => l.route.path).filter((p) => p.startsWith('/srv/'))) {
    for (const corpo of CORPOS) {
      const antes = LOGS.length;
      const r = await pedir(caso, corpo);
      const registro = LOGS.slice(antes).find((l) => l.nivel === 'error' && l.msg === '[UnhandledError]');
      if (r.status !== 500 || r.code !== 'INTERNAL_ERROR') falhas.push(`${caso} ${corpo} -> ${r.status} ${r.code}`);
      else if (!registro || !registro.obj.err || !/\n\s+at /.test(registro.obj.err.stack || '')) falhas.push(`${caso} ${corpo}: sem registro de ERRO com a pilha`);
      if (r.txt.includes(SEGREDO) || r.txt.includes('987654')) falhas.push(`${caso} ${corpo}: o valor voltou na resposta`);
    }
  }
  assert.deepEqual(falhas, [], 'todo defeito do servidor é 500 e aparece no registro como ERRO, com a pilha');
  const valor = `${SEGREDO}-${'y'.repeat(40)}`;
  for (const [caso, esperado] of [['/cli/cast', 'INVALID_FIELD_VALUE'], ['/cli/texto-longo', 'VALUE_TOO_LONG'], ['/cli/uuid', 'INVALID_ID_FORMAT']]) {
    const r = await pedir(caso, JSON.stringify({ v: valor }));
    assert.deepEqual([r.status, r.code], [400, esperado], `${caso}: ${r.txt}`);
    assert.ok(!r.txt.includes(SEGREDO), `${caso}: sem o valor na resposta`);
  }
  await sequelize.close();
});
