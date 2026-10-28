'use strict';

// M9-D018 — transforma o inputSchema declarado pela tool no schema ESTRITO usado na validação. Nada é "consertado" em
// silêncio: o que o livro exige e o schema omite recebe o limite do parâmetro (texto, lista, additionalProperties:false); o que
// não pode ter padrão (número sem faixa, id sem uuid, dinheiro em número, lista sem items) é definição inválida.

const AppError = require('../../../utils/AppError');

const CODIGO_DEFINICAO = 'AI_TOOL_DEFINITION_INVALID';
const NOMES_DE_ID = /(?:^id$|Id$|_id$)/;
const NOMES_DE_DINHEIRO = /(?:valor|amount|preco|price|custo|cost|saldo|total|montante|pagamento|payment|aluguel|rent)/i;
const COMBINADORES = ['anyOf', 'oneOf', 'allOf'];
const SCHEMA_VAZIO = Object.freeze({ type: 'object', properties: {} });

function definicaoInvalida(caminho, motivo) {
  return new AppError('Definição de ferramenta inválida.', 500, CODIGO_DEFINICAO, { path: caminho || '(raiz)', reason: motivo });
}

const temFaixa = (s) => ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum'].some((k) => s[k] !== undefined);
const ehNumero = (s) => s.type === 'number' || s.type === 'integer';

function tratarObjeto(s, limites, caminho) {
  if (s.additionalProperties !== undefined && s.additionalProperties !== false) throw definicaoInvalida(caminho, 'additionalProperties_aberto');
  s.additionalProperties = false;
  s.properties = s.properties || {};
  if (s.patternProperties) throw definicaoInvalida(caminho, 'patternProperties_nao_permitido');
  for (const [nome, filho] of Object.entries(s.properties)) {
    if (!filho || typeof filho !== 'object') throw definicaoInvalida(`${caminho}.${nome}`, 'propriedade_sem_schema');
    s.properties[nome] = tratar(filho, limites, `${caminho}.${nome}`, nome);
  }
}

function tratarTexto(s, limites, caminho, nome) {
  if (s.maxLength === undefined) s.maxLength = limites.stringMax;
  if (nome && NOMES_DE_ID.test(nome) && s.format !== 'uuid' && s.enum === undefined && s.const === undefined && s.pattern === undefined) {
    throw definicaoInvalida(caminho, 'id_sem_format_uuid');
  }
}

function tratarNumero(s, caminho, nome) {
  if (nome && NOMES_DE_DINHEIRO.test(nome)) throw definicaoInvalida(caminho, 'dinheiro_so_em_string_decimal');
  if (!temFaixa(s) && s.enum === undefined && s.const === undefined) throw definicaoInvalida(caminho, 'numero_sem_minimum_maximum');
}

function tratarLista(s, limites, caminho) {
  if (s.maxItems === undefined) s.maxItems = limites.arrayMax;
  if (!s.items || typeof s.items !== 'object' || Array.isArray(s.items)) throw definicaoInvalida(caminho, 'lista_sem_items');
  s.items = tratar(s.items, limites, `${caminho}[]`, null);
}

function tratar(original, limites, caminho, nome) {
  const s = JSON.parse(JSON.stringify(original));
  if (s.$ref !== undefined || s.$data !== undefined) throw definicaoInvalida(caminho, 'referencia_nao_permitida');
  for (const k of COMBINADORES) {
    if (Array.isArray(s[k])) s[k] = s[k].map((x, i) => tratar(x, limites, `${caminho}.${k}[${i}]`, nome));
  }
  if (s.type === 'object' || s.properties) tratarObjeto(s, limites, caminho);
  if (s.type === 'string') tratarTexto(s, limites, caminho, nome);
  if (ehNumero(s)) tratarNumero(s, caminho, nome);
  if (s.type === 'array') tratarLista(s, limites, caminho);
  return s;
}

/** Schema estrito da tool. Tool sem inputSchema não aceita argumento algum (falha fechada). */
function buildStrictSchema(inputSchema, limites) {
  if (inputSchema === undefined || inputSchema === null) return tratar(SCHEMA_VAZIO, limites, '', null);
  if (typeof inputSchema !== 'object' || Array.isArray(inputSchema) || inputSchema.type !== 'object') throw definicaoInvalida('', 'raiz_precisa_ser_objeto');
  return tratar(inputSchema, limites, '', null);
}

module.exports = { buildStrictSchema, CODIGO_DEFINICAO };
