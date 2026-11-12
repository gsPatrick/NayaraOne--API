'use strict';

const util = require('node:util');

/**
 * Erro de tipo causado por um campo do pedido com o tipo errado (verificação independente do Marco 9, rodada 7, 12/11/2026; DI-M9R-21).
 *
 * Quando a rota não valida o tipo na porta, um objeto ou um número onde o código espera um texto acaba num `TypeError` do JavaScript
 * (`email.toLowerCase is not a function`, `(personType || "PF").toUpperCase is not a function`, `items is not iterable`) e a rota dava 500.
 * Este guarda só reconhece o erro como DO CLIENTE quando há prova no próprio pedido:
 * - a mensagem do JavaScript cita a expressão que falhou (`email.toLowerCase`), e
 * - o corpo ou a consulta tem um campo com um dos nomes dessa expressão (`email`) cujo valor NÃO tem o método chamado (um objeto não tem
 *   `toLowerCase`) ou não é percorrível (`is not iterable`).
 * Sem essa prova o erro continua 500 (falha do código). Com ela, a resposta é 400 `INVALID_FIELD_TYPE` com o nome do campo, e o registro sai como
 * ERRO com a pilha (nunca escondido como aviso): a rota precisa de validação de tipo na porta, e o log mostra onde.
 * O mesmo vale para o "Invalid value" do Sequelize (objeto ou lista como valor simples de uma consulta), com a prova descrita em mapInvalidValueError.
 */
const PALAVRAS = new Set(['undefined', 'null', 'true', 'false', 'this', 'new', 'typeof', 'void', 'await', 'String', 'Number', 'Object', 'Array', 'Boolean', 'JSON']);

/** Expressão e método citados pelo V8: "x.y.z is not a function" -> { expressao: 'x.y', metodo: 'z' }; "x is not iterable" -> { expressao: 'x' }. */
function lerMensagem(mensagem) {
  const m = /^(.+)\.([A-Za-z_$][\w$]*) is not a function$/.exec(mensagem);
  if (m) return { expressao: m[1], metodo: m[2] };
  const it = /^(.+?) is not iterable(?: \(cannot read property Symbol\(Symbol\.iterator\)\))?$/.exec(mensagem);
  if (it) return { expressao: it[1], metodo: null };
  return null;
}

/** Nomes que aparecem na expressão (fora de textos entre aspas). */
function nomesDaExpressao(expressao) {
  const semTextos = expressao.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g, ' ');
  return [...new Set(semTextos.match(/[A-Za-z_$][\w$]*/g) || [])].filter((n) => !PALAVRAS.has(n));
}

/** O valor não poderia ter rodado a chamada: falta o método ou não é percorrível. */
function valorIncompativel(valor, metodo) {
  if (valor === null || valor === undefined) return false;
  if (metodo === null) return typeof valor !== 'string' && !Array.isArray(valor);
  try {
    return typeof Object(valor)[metodo] !== 'function';
  } catch (_e) {
    return false;
  }
}

/** Campos (em qualquer nível, até `maxNos` valores) com um dos nomes e valor incompatível. Iterativo; a forma do corpo já foi limitada na porta. */
function camposIncompativeis(raiz, nomes, metodo, maxNos = 100000) {
  const achados = new Set();
  const pilha = [raiz];
  let nos = 0;
  while (pilha.length > 0 && nos < maxNos) {
    const atual = pilha.pop();
    nos += 1;
    if (!atual || typeof atual !== 'object' || Buffer.isBuffer(atual)) continue;
    for (const chave of Object.keys(atual)) {
      const valor = atual[chave];
      if (nomes.includes(chave) && valorIncompativel(valor, metodo)) achados.add(chave);
      if (valor && typeof valor === 'object') pilha.push(valor);
    }
  }
  return [...achados];
}

/** TypeError de campo com tipo errado -> { statusCode, code, message, details } ou null (sem prova no pedido: continua 500). */
function mapClientTypeError(err, req) {
  if (!(err instanceof TypeError) || !req) return null;
  const lido = lerMensagem(String(err.message || ''));
  if (!lido) return null;
  const nomes = nomesDaExpressao(lido.expressao);
  if (nomes.length === 0) return null;
  const campos = [...new Set([...camposIncompativeis(req.body, nomes, lido.metodo), ...camposIncompativeis(req.query, nomes, lido.metodo)])];
  if (campos.length === 0) return null;
  const nome = campos[0].length > 64 ? `${campos[0].slice(0, 64)}…` : campos[0];
  return {
    statusCode: 400,
    code: 'INVALID_FIELD_TYPE',
    message: `O campo "${nome}" tem um tipo de valor que esta rota não aceita.`,
    details: { fields: campos, problems: campos.map((c) => ({ field: c, message: `O campo "${c}" tem um tipo de valor que esta rota não aceita.` })) },
  };
}

const MENSAGEM_SEM_CAMPO = 'Um campo enviado tem um tipo de valor que esta rota não aceita.';

/** Campos com valor estruturado (objeto ou lista), em qualquer nível, até `maxNos` valores: [nome, valor]. Iterativo. */
function camposEstruturados(raiz, maxNos = 100000) {
  const achados = [];
  const pilha = [raiz];
  let nos = 0;
  while (pilha.length > 0 && nos < maxNos) {
    const atual = pilha.pop();
    nos += 1;
    if (!atual || typeof atual !== 'object' || Buffer.isBuffer(atual)) continue;
    for (const chave of Object.keys(atual)) {
      const valor = atual[chave];
      if (valor && typeof valor === 'object' && !Buffer.isBuffer(valor)) { achados.push([chave, valor]); pilha.push(valor); }
    }
  }
  return achados;
}

/**
 * "Invalid value { x: 1 }" do Sequelize: um objeto ou uma lista usados como valor simples numa consulta (filtro ou substituição de SQL). Prova no
 * pedido: o corpo ou a consulta têm um valor estruturado; o campo é apontado quando a impressão do valor é a mesma da mensagem. Sem valor
 * estruturado no pedido, o erro é do código e continua 500. A mensagem do Sequelize traz o valor: nunca vai na resposta.
 */
function mapInvalidValueError(err, req) {
  if (!(err instanceof Error) || err instanceof TypeError || !req || err.parent) return null;
  const m = /^Invalid value ([\s\S]+)$/.exec(String(err.message || ''));
  if (!m) return null;
  const estruturados = [...camposEstruturados(req.body), ...camposEstruturados(req.query)];
  if (estruturados.length === 0) return null;
  const campos = [...new Set(estruturados.filter(([, v]) => { try { return util.inspect(v) === m[1]; } catch (_e) { return false; } }).map(([c]) => c))];
  const nome = campos.length === 1 ? (campos[0].length > 64 ? `${campos[0].slice(0, 64)}…` : campos[0]) : null;
  const message = nome ? `O campo "${nome}" tem um tipo de valor que esta rota não aceita.` : MENSAGEM_SEM_CAMPO;
  return { statusCode: 400, code: 'INVALID_FIELD_TYPE', message, details: { fields: campos, problems: campos.map((c) => ({ field: c, message: `O campo "${c}" tem um tipo de valor que esta rota não aceita.` })) } };
}

const NUMERICOS = new Set(['integer', 'numeric', 'bigint', 'smallint', 'double precision', 'real', 'boolean']);

/** Algum número ou booleano no corpo ou na consulta (até `maxNos` valores). Iterativo. */
function temNumeroOuBooleano(raiz, maxNos = 100000) {
  const pilha = [raiz];
  let nos = 0;
  while (pilha.length > 0 && nos < maxNos) {
    const atual = pilha.pop();
    nos += 1;
    if (typeof atual === 'number' || typeof atual === 'boolean') return true;
    if (atual && typeof atual === 'object' && !Buffer.isBuffer(atual)) for (const chave of Object.keys(atual)) pilha.push(atual[chave]);
  }
  return false;
}

/**
 * 42883 "operator does not exist: character varying = integer" (ou uuid = numeric ...): um número ou booleano do pedido comparado com uma coluna de
 * texto, de identificador ou de data numa consulta. Prova no pedido: o corpo ou a consulta têm um número ou booleano. Coluna de identificador:
 * 400 INVALID_ID_FORMAT; as demais: 400 INVALID_FIELD_TYPE. Sem a prova (ou com os dois lados numéricos), continua 500.
 */
function mapOperatorTypeError(err, req) {
  const pg = err && err.parent;
  if (!pg || pg.code !== '42883' || !req) return null;
  const m = /operator does not exist: ([a-z][a-z ]*?) (?:=|<>|<|>|<=|>=) ([a-z][a-z ]*?)(?:$|\n|\s*$)/i.exec(String(pg.message || ''));
  if (!m) return null;
  const [esquerda, direita] = [m[1].trim().toLowerCase(), m[2].trim().toLowerCase()];
  if (NUMERICOS.has(esquerda) === NUMERICOS.has(direita)) return null;
  if (!temNumeroOuBooleano(req.body) && !temNumeroOuBooleano(req.query)) return null;
  const coluna = NUMERICOS.has(esquerda) ? direita : esquerda;
  if (coluna === 'uuid') return { statusCode: 400, code: 'INVALID_ID_FORMAT', message: 'O identificador informado não é válido.', details: { fields: [] } };
  return { statusCode: 400, code: 'INVALID_FIELD_TYPE', message: MENSAGEM_SEM_CAMPO, details: { fields: [] } };
}

/**
 * "Argument passed to findByPk is invalid": o Sequelize só aceita texto, número ou Buffer como identificador. Prova no pedido: o corpo ou a consulta
 * têm um valor estruturado (objeto ou lista) ou um booleano. 400 INVALID_ID_FORMAT; sem a prova, continua 500.
 */
function mapFindByPkError(err, req) {
  if (!(err instanceof Error) || err.parent || !req || !/^Argument passed to findByPk is invalid/.test(String(err.message || ''))) return null;
  const temBooleano = (raiz) => { const p = [raiz]; let n = 0; while (p.length && n < 100000) { const a = p.pop(); n += 1; if (typeof a === 'boolean') return true; if (a && typeof a === 'object' && !Buffer.isBuffer(a)) p.push(...Object.values(a)); } return false; };
  const prova = camposEstruturados(req.body).length > 0 || camposEstruturados(req.query).length > 0 || temBooleano(req.body) || temBooleano(req.query);
  return prova ? { statusCode: 400, code: 'INVALID_ID_FORMAT', message: 'O identificador informado não é válido.', details: { fields: [] } } : null;
}

module.exports = { mapClientTypeError, mapInvalidValueError, mapOperatorTypeError, mapFindByPkError, lerMensagem, nomesDaExpressao };
