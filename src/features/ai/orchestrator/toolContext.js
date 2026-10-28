'use strict';

// M9-D002 — fronteira de capacidades da NAY (Caderno, seção 8): "NAY nunca recebe shell, banco SQL livre,
// secret manager ou adapter bancário de execução." O objeto passado a `execute(ctx, input)` de toda tool é
// fechado e congelado: só as chaves de CONTEXT_KEYS, e `services`/`readModels` são mapas explícitos.
// Pedir qualquer outra coisa é bloqueado (403 AI_CAPABILITY_FORBIDDEN) e auditado pelo executor de tools.

const AppError = require('../../../utils/AppError');

const MENSAGEM_CAPACIDADE_NEGADA = 'Esta capacidade não é concedida à NAY (regra de segurança do Nayara One).';
const CODIGO_CAPACIDADE_NEGADA = 'AI_CAPABILITY_FORBIDDEN';

const CONTEXT_KEYS = Object.freeze(['auth', 'companyId', 'groupId', 'services', 'readModels', 'logger', 'correlationId']);

// Nomes que nunca podem existir no contexto nem nos mapas de serviços/read models (comparação sem caixa e
// sem separadores). Cobrem banco/SQL livre, secret manager, shell/processo/disco e adapters de execução.
const NOME_PROIBIDO = /^(?:sequelize|query.?interface|database|db|knex|pool|raw.?quer(?:y|ies)|sql|pg|secrets?|secret.?(?:store|manager)|vault|credentials?|shell|exec|spawn|process|env|fs|child.?process|vm|bank|banco|bank.?adapter|payment.?adapter|pix.?adapter|signature.?adapter|adapter.?bancario)$/i;
const FRAGMENTO_PROIBIDO = /secret|adapter|bank|banco|sequelize|shell|child.?process/i;
const IGNORADAS_NO_ACESSO = new Set(['then', 'toJSON', 'toString', 'valueOf', 'inspect', 'constructor', 'asymmetricMatch', '$$typeof', 'nodeType']);

function capacidadeNegada(capability, extra = {}) {
  return new AppError(MENSAGEM_CAPACIDADE_NEGADA, 403, CODIGO_CAPACIDADE_NEGADA, { capability: String(capability), ...extra });
}

function nomeProibido(nome) {
  return NOME_PROIBIDO.test(String(nome)) || FRAGMENTO_PROIBIDO.test(String(nome));
}

// Um serviço/read model que carrega a conexão do banco (acesso a SQL livre) não é aceito como "serviço".
function expoeBanco(valor) {
  if (!valor || (typeof valor !== 'object' && typeof valor !== 'function')) return false;
  return typeof valor.getQueryInterface === 'function' || typeof valor.query === 'function' || typeof valor.transaction === 'function'
    || (valor.models && typeof valor.models === 'object' && typeof valor.define === 'function');
}

function mapaPermitido(nomeMapa, mapa, tipoEsperado) {
  if (mapa === undefined || mapa === null) return Object.freeze({});
  if (typeof mapa !== 'object' || Array.isArray(mapa)) throw capacidadeNegada(nomeMapa, { reason: 'mapa_invalido' });
  const copia = {};
  for (const [nome, valor] of Object.entries(mapa)) {
    if (nomeProibido(nome)) throw capacidadeNegada(nome, { reason: `${nomeMapa}_proibido` });
    if (expoeBanco(valor)) throw capacidadeNegada(nome, { reason: `${nomeMapa}_expoe_banco` });
    if (tipoEsperado === 'function' && typeof valor !== 'function') throw capacidadeNegada(nome, { reason: 'read_model_nao_e_funcao' });
    if (tipoEsperado === 'object' && (typeof valor !== 'object' || valor === null)) throw capacidadeNegada(nome, { reason: 'servico_invalido' });
    copia[nome] = tipoEsperado === 'object' ? Object.freeze({ ...valor }) : valor;
  }
  return Object.freeze(copia);
}

function loggerSeguro(logger) {
  const base = logger || {};
  const noop = () => {};
  const f = (n) => (typeof base[n] === 'function' ? (...a) => base[n](...a) : noop);
  return Object.freeze({ debug: f('debug'), info: f('info'), warn: f('warn'), error: f('error') });
}

/**
 * Monta o contexto congelado da tool. Qualquer chave fora de CONTEXT_KEYS é recusada (403), assim como
 * serviço/read model com nome proibido. Os mapas são COPIADOS: alterar o original depois não concede nada.
 */
function buildToolContext(partes) {
  const entrada = partes || {};
  for (const chave of Object.keys(entrada)) {
    if (!CONTEXT_KEYS.includes(chave)) throw capacidadeNegada(chave, { reason: 'chave_fora_do_contexto' });
  }
  if (!entrada.auth || typeof entrada.auth !== 'object') throw AppError.badRequest('Contexto da tool sem identidade (auth).', 'AI_CONTEXT_INVALID');
  if (!entrada.companyId || !entrada.groupId) throw AppError.badRequest('Contexto da tool sem empresa/grupo.', 'AI_CONTEXT_INVALID');
  const auth = Object.freeze({ ...entrada.auth, permissions: Object.freeze([...(entrada.auth.permissions || [])]) });
  const ctx = Object.create(null);
  ctx.auth = auth;
  ctx.companyId = entrada.companyId;
  ctx.groupId = entrada.groupId;
  ctx.services = mapaPermitido('services', entrada.services, 'object');
  ctx.readModels = mapaPermitido('readModels', entrada.readModels, 'function');
  ctx.logger = loggerSeguro(entrada.logger);
  ctx.correlationId = entrada.correlationId;
  return Object.freeze(ctx);
}

/**
 * Visão que a tool recebe: leitura do contexto congelado; qualquer chave inexistente (ctx.sequelize,
 * ctx.secrets, ctx.services.bank...) registra a tentativa via `onAttempt` e lança 403 AI_CAPABILITY_FORBIDDEN.
 */
function guardContext(ctx, onAttempt) {
  const negar = (capability, caminho) => {
    onAttempt({ capability: String(capability), path: caminho });
    throw capacidadeNegada(capability, { path: caminho });
  };
  const visao = (alvo, caminho, filhos) => new Proxy(Object.freeze(Object.create(null)), {
    get(_t, prop) {
      if (typeof prop === 'symbol') return undefined;
      if (Object.prototype.hasOwnProperty.call(alvo, prop)) {
        const v = alvo[prop];
        if (filhos && filhos.has(prop)) return visao(v, `${caminho}.${prop}`, null);
        return v;
      }
      if (IGNORADAS_NO_ACESSO.has(prop)) return undefined;
      return negar(prop, `${caminho}.${prop}`);
    },
    has(_t, prop) { return typeof prop === 'string' && Object.prototype.hasOwnProperty.call(alvo, prop); },
    set(_t, prop) { return negar(prop, `${caminho}.${String(prop)}`); },
    defineProperty(_t, prop) { return negar(prop, `${caminho}.${String(prop)}`); },
    deleteProperty(_t, prop) { return negar(prop, `${caminho}.${String(prop)}`); },
  });
  return visao(ctx, 'ctx', new Set(['services', 'readModels']));
}

module.exports = { CONTEXT_KEYS, MENSAGEM_CAPACIDADE_NEGADA, CODIGO_CAPACIDADE_NEGADA, buildToolContext, guardContext, capacidadeNegada, nomeProibido };
