'use strict';

const Ajv = require('ajv');
const AppError = require('../../utils/AppError');
const { isStorableText } = require('../../utils/storableText');
const { dataIsoValida } = require('../../utils/isoDate');

/**
 * Validação de TIPO na porta de uma rota, pelo esquema da rota (verificação independente do Marco 9, rodada 7, 12/11/2026; DI-M9R-21).
 * Mesmo padrão das rotas de mensagem (src/features/crm/messages.validate.js, DI-M9R-11): Ajv sem conversão de tipo e sem preencher nada; o pedido
 * passa como veio ou é recusado com 400 e o código de validação do módulo (`PERSON_VALIDATION`, `AUTH_VALIDATION` ...), o nome do campo na mensagem
 * e em `details.fields`, e `details.problems` com { field, message } de cada campo (o formato que a tela já lê). Nunca o valor recebido.
 *
 * Diferente das mensagens, estes esquemas são ABERTOS (campo que o esquema não cita passa, como sempre passou): o que se fecha é o tipo e o tamanho
 * dos campos de texto e de identificador que a rota usa. Assim a tela e as integrações que já mandam campos a mais continuam funcionando.
 */
const ajv = new Ajv({ allErrors: true, jsonPointers: true, coerceTypes: false, useDefaults: false, removeAdditional: false, verbose: false });
ajv.addKeyword('descricao', { metaSchema: { type: 'string' } });
ajv.addKeyword('textoGravavel', { type: 'string', metaSchema: { type: 'boolean' }, validate: (ativo, valor) => !ativo || isStorableText(valor), errors: false });
/** Tamanho em caracteres como o banco conta (pontos de código; um emoji é 1), não em unidades UTF-16 como o `maxLength` do Ajv 6. */
ajv.addKeyword('maxCaracteres', {
  type: 'string',
  metaSchema: { type: 'integer', minimum: 0 },
  validate: (max, valor) => {
    if (valor.length <= max) return true;
    let n = 0;
    for (const _c of valor) { n += 1; if (n > max) return false; } // eslint-disable-line no-unused-vars
    return true;
  },
  errors: false,
});

/**
 * Data em texto que o servidor e o banco leem do mesmo jeito (rodada 8, DI-M9R-25). O Sequelize converte o texto do campo de data num objeto Date;
 * texto que não é data vira "Invalid date" no comando, e o banco recusa um valor que NÃO está no pedido (sem prova de que é do cliente, o erro seria
 * 500). Por isso a data é conferida na porta: vazio ('') passa (o serviço trata como "sem data"); o resto tem de ser ISO 8601 válida
 * (src/utils/isoDate.js).
 */
ajv.addKeyword('dataLegivel', { type: 'string', metaSchema: { type: 'boolean' }, validate: (ativo, valor) => !ativo || valor.trim() === '' || dataIsoValida(valor), errors: false });

const UUID_PATTERN = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
const NOME_DA_PARTE = Object.freeze({ body: 'corpo do pedido', query: 'consulta', params: 'caminho' });

/** Primeiro segmento do caminho JSON do erro (`/contacts/0/value` -> `contacts`). */
const campoDoCaminho = (dataPath) => (dataPath || '').split('/')[1]?.replace(/~1/g, '/').replace(/~0/g, '~') || null;

function descrever(erro, schema, parte) {
  if (erro.keyword === 'required') {
    const campo = erro.params.missingProperty.replace(/^[./]/, '');
    return { campo, mensagem: `O campo "${campo}" é obrigatório.` };
  }
  const campo = campoDoCaminho(erro.dataPath);
  if (!campo) return { campo: NOME_DA_PARTE[parte], mensagem: `O ${NOME_DA_PARTE[parte]} deve ser um objeto JSON com os campos da rota.` };
  if (erro.keyword === 'textoGravavel') return { campo, mensagem: `O campo "${campo}" tem um caractere que não pode ser gravado (caractere nulo ou metade solta de um caractere Unicode).` };
  const definicao = (Object.prototype.hasOwnProperty.call(schema.properties || {}, campo) && schema.properties[campo]) || {};
  return { campo, mensagem: `O campo "${campo}" deve ser ${definicao.descricao || 'do tipo indicado pela rota'}.` };
}

/** Esquema compilado de cada parte. `codigo` é o código de erro do módulo. */
function compilarRota(partes, codigo, { status = 400 } = {}) {
  if (!codigo) throw new Error('Esquema de rota sem código de erro');
  return {
    codigo,
    status,
    partes: Object.fromEntries(Object.entries(partes).map(([parte, schema]) => [parte, { schema, valida: ajv.compile(schema) }])),
  };
}

/** Confere `params`, `query` e `body` (nesta ordem) e lança o 400 com o primeiro problema; `details` lista todos os da parte recusada. */
function conferirPedido(rota, req) {
  for (const parte of ['params', 'query', 'body']) {
    const item = rota.partes[parte];
    if (!item) continue;
    const valor = req[parte] === undefined || req[parte] === null ? {} : req[parte];
    if (item.valida(valor)) continue;
    const problemas = item.valida.errors.map((e) => descrever(e, item.schema, parte));
    const vistos = new Map();
    for (const p of problemas) if (!vistos.has(p.campo)) vistos.set(p.campo, p.mensagem);
    throw new AppError(problemas[0].mensagem, rota.status || 400, rota.codigo, {
      fields: [...vistos.keys()],
      problems: [...vistos.entries()].map(([field, message]) => ({ field, message })),
    });
  }
}

/**
 * Middleware: `router.post('/people', requirePermission(...), validarEntrada({ body: ESQUEMA }, 'PERSON_VALIDATION'), controller)`. `opcoes.status`:
 * o status da recusa quando o módulo usa outro que não 400 (o registro de flags da governança usa 422).
 */
function validarEntrada(partes, codigo, opcoes) {
  const rota = compilarRota(partes, codigo, opcoes);
  const middleware = (req, _res, next) => {
    try {
      conferirPedido(rota, req);
      return next();
    } catch (err) {
      return next(err);
    }
  };
  // Rodada 8 (DI-M9R-24): os campos da consulta do tipo `array` são os que o contrato da consulta (queryContract.js) aceita como lista nesta rota.
  const props = (partes.query && partes.query.properties) || {};
  middleware.listasDaConsulta = Object.keys(props).filter((k) => [].concat(props[k].type || []).includes('array'));
  return middleware;
}

/** Parâmetro de consulta em texto: `opcoes` = { max, enum, pattern, descricao } (a consulta chega sempre como texto, nunca número). */
const textoDaConsulta = ({ max = 200, valores = null, padrao = null, descricao = null } = {}) => ({
  type: 'string',
  textoGravavel: true,
  maxCaracteres: max,
  ...(valores ? { enum: valores } : {}),
  ...(padrao ? { pattern: padrao } : {}),
  descricao: descricao || (valores ? `um destes valores: ${valores.join(', ')}` : `um texto de até ${max} caracteres`),
});
/** Inteiro em texto (paginação e tamanhos): só dígitos, até `maxDigitos`. */
const inteiroDaConsulta = ({ maxDigitos = 9 } = {}) => ({ type: 'string', pattern: `^\\d{1,${maxDigitos}}$`, descricao: 'um número inteiro (só dígitos)' });

// --- Peças dos esquemas ---

const objetoAberto = (properties, required = []) => ({ type: 'object', properties, required });
/** Texto de até `max` caracteres (o tamanho da coluna); `nulo` aceita null. */
const texto = (max, { nulo = true } = {}) => ({
  type: nulo ? ['string', 'null'] : 'string',
  textoGravavel: true,
  ...(max ? { maxCaracteres: max } : {}),
  descricao: max ? `um texto de até ${max} caracteres` : 'um texto',
});
/** Identificador (UUID) em texto; `vazio` aceita "" (o serviço trata como "sem vínculo"). */
const identificador = ({ nulo = true, vazio = true } = {}) => ({
  type: nulo ? ['string', 'null'] : 'string',
  pattern: vazio ? `^(?:|${UUID_PATTERN.slice(1, -1)})$` : UUID_PATTERN,
  descricao: 'um identificador (UUID) em texto',
});
/** Data ou data e hora em texto (o banco confere o formato; aqui só o tipo e um tamanho razoável). */
const dataEmTexto = ({ nulo = true } = {}) => ({ type: nulo ? ['string', 'null'] : 'string', maxLength: 64, textoGravavel: true, dataLegivel: true, descricao: 'uma data em texto (AAAA-MM-DD ou data e hora ISO)' });
const numeroOuTexto = ({ nulo = true } = {}) => ({ type: nulo ? ['number', 'string', 'null'] : ['number', 'string'], maxLength: 64, descricao: 'um número' });
const booleano = ({ nulo = true } = {}) => ({ type: nulo ? ['boolean', 'null'] : 'boolean', descricao: 'verdadeiro ou falso' });
const objeto = ({ nulo = true } = {}) => ({ type: nulo ? ['object', 'null'] : 'object', descricao: 'um objeto JSON' });
const lista = (itens, { nulo = true } = {}) => ({ type: nulo ? ['array', 'null'] : 'array', items: itens, descricao: 'uma lista' });

/** Tamanho da coluna de texto de um atributo do modelo (STRING(N) ou CHAR(N)); TEXT e outros tipos: null (sem limite de tamanho aqui). */
function tamanhoDaColuna(Modelo, atributo) {
  const def = Modelo.rawAttributes[atributo];
  if (!def) throw new Error(`Atributo desconhecido no esquema da rota: ${Modelo.name}.${atributo}`);
  const tipo = def.type && def.type.key;
  if (tipo !== 'STRING' && tipo !== 'CHAR' && tipo !== 'TEXT' && tipo !== 'CITEXT') throw new Error(`Atributo não é texto: ${Modelo.name}.${atributo} (${tipo})`);
  const n = def.type.options && Number(def.type.options.length);
  return tipo === 'TEXT' || tipo === 'CITEXT' || !Number.isInteger(n) ? null : n;
}
/** Texto com o limite da coluna do modelo (o limite acompanha o modelo; o teste da rota confere que o banco tem o mesmo tamanho). */
const textoDoModelo = (Modelo, atributo, opcoes) => ({ ...texto(tamanhoDaColuna(Modelo, atributo), opcoes), coluna: `${Modelo.name}.${atributo}` });
ajv.addKeyword('coluna', { metaSchema: { type: 'string' } });

module.exports = {
  validarEntrada, compilarRota, conferirPedido,
  objetoAberto, texto, textoDoModelo, tamanhoDaColuna, identificador, dataEmTexto, numeroOuTexto, booleano, objeto, lista, UUID_PATTERN,
  textoDaConsulta, inteiroDaConsulta,
};
