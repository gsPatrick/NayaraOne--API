'use strict';

// M9-D018 — validação ESTRITA dos argumentos de tool no servidor (Ajv): campo desconhecido, tipo errado (sem coerção), formato,
// tamanho e dinheiro fora de string decimal rejeitam a chamada inteira. companyId/groupId/userId nunca vêm do modelo (D017):
// presença em qualquer nível, com qualquer valor, é 400 AI_TOOL_ARGS_FORBIDDEN_FIELD. A resposta lista os CAMPOS inválidos, nunca os valores.

const Ajv = require('ajv');
const AppError = require('../../../utils/AppError');
const { maskSecrets } = require('../guards/secretPatterns');
const { buildStrictSchema, CODIGO_DEFINICAO } = require('./argsSchema');

const BLOCKED_REASON = 'SCHEMA';
const MENSAGEM_CAMPO_PROIBIDO = 'Este campo é definido pelo servidor e não pode ser informado.';
const CAMPOS_DO_SERVIDOR = new Set(['companyid', 'groupid', 'userid']);
const PROFUNDIDADE_MAXIMA = 20;
const MAX_CAMPOS_LISTADOS = 20;
const MAX_CARACTERES_DO_CAMPO = 80;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DINHEIRO = /^\d+(\.\d{1,2})?$/;

function criarAjv() {
  const ajv = new Ajv({ allErrors: true, coerceTypes: false, removeAdditional: false, useDefaults: true, strictKeywords: true, format: 'full', nullable: false });
  ajv.addFormat('uuid', UUID);
  ajv.addFormat('money', DINHEIRO);
  // freeText: texto livre do ator passa pelo redactor (credencial e dado pessoal viram máscara) e continua limitado pelo maxLength.
  ajv.addKeyword('freeText', {
    type: 'string',
    modifying: true,
    metaSchema: { type: 'boolean' },
    validate: function freeText(ligado, dado, schemaPai, _caminho, objetoPai, chave) {
      if (ligado !== true || !objetoPai) return true;
      const mascarado = maskSecrets(dado);
      objetoPai[chave] = schemaPai.maxLength ? mascarado.slice(0, schemaPai.maxLength) : mascarado;
      return true;
    },
  });
  return ajv;
}

const ajv = criarAjv();
const compilados = new WeakMap(); // inputSchema -> Map(chave dos limites -> função de validação)

function compilar(tool, limites) {
  const origem = tool.inputSchema === undefined || tool.inputSchema === null ? tool : tool.inputSchema;
  const chave = `${limites.stringMax}:${limites.arrayMax}`;
  let porLimites = compilados.get(origem);
  if (!porLimites) { porLimites = new Map(); compilados.set(origem, porLimites); }
  if (!porLimites.has(chave)) {
    const estrito = buildStrictSchema(tool.inputSchema, limites);
    try {
      porLimites.set(chave, ajv.compile(estrito));
    } catch (e) {
      throw new AppError('Definição de ferramenta inválida.', 500, CODIGO_DEFINICAO, { reason: 'schema_nao_compila' });
    }
  }
  return porLimites.get(chave);
}

const limpo = (s) => String(s).replace(/[^\w.[\]-]/g, '?').slice(0, MAX_CARACTERES_DO_CAMPO);
const normalizaNome = (n) => String(n).replace(/[_-]/g, '').toLowerCase();

/** Caminhos (ex. "filtro.companyId", "itens[0].userId") das chaves reservadas ao servidor, em qualquer nível. */
function camposProibidos(valor, caminho = '', profundidade = 0, achados = []) {
  if (valor === null || typeof valor !== 'object' || profundidade > PROFUNDIDADE_MAXIMA) return achados;
  if (Array.isArray(valor)) {
    valor.forEach((v, i) => camposProibidos(v, `${caminho}[${i}]`, profundidade + 1, achados));
    return achados;
  }
  for (const [chave, v] of Object.entries(valor)) {
    const dest = caminho ? `${caminho}.${chave}` : chave;
    if (CAMPOS_DO_SERVIDOR.has(normalizaNome(chave))) achados.push(limpo(dest));
    camposProibidos(v, dest, profundidade + 1, achados);
  }
  return achados;
}

/** Caminho do erro do Ajv sem o valor informado: ".a.b[0]" -> "a.b[0]"; propriedade faltante/extra é anexada. */
function campoDoErro(erro) {
  const base = String(erro.dataPath || '').replace(/^\./, '').replace(/\['([^']*)'\]/g, '.$1').replace(/^\./, '');
  const extra = erro.params && (erro.params.missingProperty || erro.params.additionalProperty);
  const completo = extra ? [base, extra].filter(Boolean).join('.') : base;
  return limpo(completo || '(raiz)');
}

function argumentosInvalidos(erros) {
  const campos = [...new Set(erros.map(campoDoErro))].slice(0, MAX_CAMPOS_LISTADOS);
  return new AppError(`Os argumentos da ferramenta são inválidos: ${campos.join(', ')}.`, 400, 'AI_TOOL_ARGS_INVALID', { fields: campos, blockedReason: BLOCKED_REASON });
}

function objetoPlano(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * Valida `input` contra o inputSchema da tool. Devolve `{ args }` (cópia validada, com defaults declarados e freeText mascarado);
 * a entrada original nunca é alterada. Lança AppError 400 (inválido / campo proibido) ou 500 (definição inválida).
 */
function validateToolArgs(tool, input, limites) {
  const validar = compilar(tool, limites);
  if (!objetoPlano(input)) throw argumentosInvalidos([{ dataPath: '' }]);
  const proibidos = camposProibidos(input);
  if (proibidos.length) {
    throw new AppError(MENSAGEM_CAMPO_PROIBIDO, 400, 'AI_TOOL_ARGS_FORBIDDEN_FIELD', { fields: proibidos.slice(0, MAX_CAMPOS_LISTADOS), blockedReason: BLOCKED_REASON });
  }
  let copia;
  try { copia = structuredClone(input); } catch (e) { throw argumentosInvalidos([{ dataPath: '' }]); }
  if (!validar(copia)) throw argumentosInvalidos(validar.errors);
  return { args: copia };
}

module.exports = { validateToolArgs, camposProibidos, BLOCKED_REASON, MENSAGEM_CAMPO_PROIBIDO };
