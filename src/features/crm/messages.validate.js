'use strict';

const Ajv = require('ajv');
const AppError = require('../../utils/AppError');
const { ROTAS, PARTES, FORA_DA_ROTA } = require('./messages.schema');
const { isStorableText } = require('../../utils/storableText');

/**
 * Validação do pedido de cada rota de mensagem pelo esquema da rota (messages.schema.js, DI-M9R-11), antes do controller e de qualquer regra.
 * Ajv sem conversão de tipo (`"1"` não vira 1, `[x]` não vira x) e sem preencher nada: o pedido passa como veio ou é recusado.
 * A resposta é 400 `MESSAGE_VALIDATION`: a mensagem cita o primeiro campo com problema e `details.fields` lista todos (só os nomes, nunca os valores).
 */
const ajv = new Ajv({ allErrors: true, jsonPointers: true, coerceTypes: false, useDefaults: false, removeAdditional: false, verbose: false });
ajv.addKeyword('enumSemCaixa', {
  type: 'string',
  metaSchema: { type: 'array', items: { type: 'string' } },
  validate: (lista, valor) => lista.includes(valor.toUpperCase()),
  errors: false,
});
ajv.addKeyword('descricao', { metaSchema: { type: 'string' } });
// Rodada 6 (DI-M9R-15): caractere nulo ou metade solta de par sub-rogado não é gravável (o jsonb do envio recusava e a rota dava 500).
ajv.addKeyword('textoGravavel', { type: 'string', metaSchema: { type: 'boolean' }, validate: (ativo, valor) => !ativo || isStorableText(valor), errors: false });
const NAO_GRAVAVEL = 'tem um caractere que não pode ser gravado (caractere nulo ou metade solta de um caractere Unicode)';

const validadores = Object.fromEntries(Object.entries(ROTAS).map(([rota, partes]) => [
  rota, Object.fromEntries(Object.entries(partes).map(([parte, schema]) => [parte, { schema, valida: ajv.compile(schema) }])),
]));

/** Nome de campo desconhecido vem do cliente: entra na mensagem cortado (no máximo 64 caracteres). */
const nomeCurto = (nome) => (String(nome).length > 64 ? `${String(nome).slice(0, 64)}…` : String(nome));
const motivoForaDaRota = (campo) => (Object.prototype.hasOwnProperty.call(FORA_DA_ROTA, campo) ? ` ${FORA_DA_ROTA[campo]}` : '');

/** Primeiro segmento do caminho JSON do erro (`/templateVars/0` -> `templateVars`). */
const campoDoCaminho = (dataPath) => (dataPath || '').split('/')[1]?.replace(/~1/g, '/').replace(/~0/g, '~') || null;

/** Mensagem de um erro do Ajv, em português e com o nome do campo; o valor recebido nunca entra na mensagem. */
function descrever(erro, schema, parte) {
  if (erro.keyword === 'additionalProperties') {
    const campo = nomeCurto(erro.params.additionalProperty);
    return { campo, mensagem: `O campo "${campo}" não é aceito nesta rota.${motivoForaDaRota(campo)}` };
  }
  if (erro.keyword === 'required') {
    const campo = erro.params.missingProperty.replace(/^[./]/, '');
    return { campo, mensagem: `O campo "${campo}" é obrigatório.` };
  }
  const campo = campoDoCaminho(erro.dataPath);
  if (!campo) return { campo: PARTES[parte], mensagem: `O ${PARTES[parte]} deve ser um objeto JSON com os campos da rota.` };
  if (erro.keyword === 'textoGravavel') return { campo, mensagem: `O campo "${campo}" ${NAO_GRAVAVEL}.` };
  const definicao = (Object.prototype.hasOwnProperty.call(schema.properties || {}, campo) && schema.properties[campo]) || {};
  return { campo, mensagem: `O campo "${campo}" deve ser ${definicao.descricao || 'do tipo indicado pela rota'}.` };
}

/**
 * Confere as partes do pedido declaradas para a rota (`params`, `query`, `body`), nesta ordem. Corpo ausente vale `{}`. Lança o 400 com o primeiro
 * problema; `details.fields` traz todos os campos com problema da parte recusada.
 */
function validarPedido(rota, req) {
  const partes = validadores[rota];
  if (!partes) throw new Error(`Rota de mensagem sem esquema: ${rota}`);
  for (const parte of ['params', 'query', 'body']) {
    if (!partes[parte]) continue;
    const { schema, valida } = partes[parte];
    const valor = req[parte] === undefined || req[parte] === null ? {} : req[parte];
    if (valida(valor)) continue;
    const problemas = valida.errors.map((e) => descrever(e, schema, parte));
    const campos = [...new Set(problemas.map((p) => p.campo))];
    throw AppError.badRequest(problemas[0].mensagem, 'MESSAGE_VALIDATION', { fields: campos });
  }
}

/** Middleware da rota: `crmRouter.post('/messages', requirePermission(...), validarMensagem('criar'), controller)`. */
const validarMensagem = (rota) => {
  if (!validadores[rota]) throw new Error(`Rota de mensagem sem esquema: ${rota}`);
  return (req, _res, next) => {
    try {
      validarPedido(rota, req);
      return next();
    } catch (err) {
      return next(err);
    }
  };
};

module.exports = { validarMensagem, validarPedido };
