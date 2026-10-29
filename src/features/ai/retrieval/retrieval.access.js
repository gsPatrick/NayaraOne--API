'use strict';

const { SOURCE_KINDS } = require('./retrieval.constants');

/**
 * Teto de classificação da busca (M9-D023, passo 2). Para o ATOR: PUBLIC, INTERNAL e CONFIDENTIAL dependem só da `required_permission`
 * do chunk (não existe permissão `ai:confidential`); RESTRICTED exige `ai:restricted` E finalidade (`opts.purpose`). Para o AGENTE/execução
 * (`opts.execution`): CONFIDENTIAL só se o provider aceita (`allowsConfidential`) e RESTRICTED só se `allowsRestricted`, os valores de
 * `connections.config_json` (D011/D027); `execution.sourceTypes` limita os tipos de fonte (derivados do `data_scopes` do agente).
 * Sem `execution` (leitura direta pela pessoa) vale só o teto do ator. Classe nunca é somada: a efetiva é a interseção dos dois tetos.
 */
const hasText = (v) => typeof v === 'string' && v.trim().length > 0;
const hasPermission = (ctx, code) => Array.isArray(ctx.permissions) && ctx.permissions.includes(code);

function allowedClassifications(ctx, opts = {}) {
  const exec = opts.execution || null;
  const out = ['PUBLIC', 'INTERNAL'];
  if (!exec || exec.allowsConfidential === true) out.push('CONFIDENTIAL');
  if (hasPermission(ctx, 'ai:restricted') && hasText(opts.purpose) && (!exec || exec.allowsRestricted === true)) out.push('RESTRICTED');
  return out;
}

function allowedSourceTypes(opts = {}) {
  const wanted = opts.execution && Array.isArray(opts.execution.sourceTypes) ? opts.execution.sourceTypes : SOURCE_KINDS;
  return SOURCE_KINDS.filter((k) => wanted.includes(k));
}

module.exports = { allowedClassifications, allowedSourceTypes };
