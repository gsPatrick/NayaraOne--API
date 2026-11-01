'use strict';

const { resolveCommit, sameCommit } = require('../../../src/features/migration-v2/dryrun/dry.commit');
const { DRY_SETTING_DEFAULTS, KEYS } = require('../../../src/features/migration-v2/dryrun/dry.settings');

const HORA_MS = 3600 * 1000;
const TOLERANCIA_FUTURO_MS = 5 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Parâmetros do vínculo (M9-D908): o fechamento não tem sessão de empresa, então lê o valor do bloco "dry3" de dod-bloco-f.json (validade_horas, volume_minimo, exigir_commit_igual,
 * company_id) ou do ambiente (MIGRATION_DRY3_COMPANY_ID); sem nada, vale o padrão do parâmetro de administração (dry.settings, os mesmos migracao.dry3.*).
 */
function parametros(cfgDry3 = {}, env = process.env) {
  const pegar = (campo, chave) => (cfgDry3[campo] !== undefined ? cfgDry3[campo] : DRY_SETTING_DEFAULTS[chave]);
  return {
    validadeHoras: Number(pegar('validade_horas', KEYS.VALIDITY_HOURS)),
    volumeMinimo: Number(pegar('volume_minimo', KEYS.MIN_VOLUME)),
    exigirCommitIgual: pegar('exigir_commit_igual', KEYS.SAME_COMMIT) !== false,
    empresa: String(env.MIGRATION_DRY3_COMPANY_ID || cfgDry3.company_id || '').trim().toLowerCase(),
  };
}

/** Problemas de vínculo do relatório a esta empresa e a este código, agora (mesma regra de dry.validity.bindingProblem, sem banco). Lista de textos; vazia = vinculado. */
function problemasDeVinculo(rel, cfgDry3, { agora = new Date(), env = process.env, commitAtual = resolveCommit().commit } = {}) {
  const p = parametros(cfgDry3, env);
  const problemas = [];
  const empresa = typeof rel.company_id === 'string' ? rel.company_id.trim().toLowerCase() : '';
  if (!UUID.test(empresa)) problemas.push('relatório sem empresa (company_id)');
  else if (p.empresa && p.empresa !== empresa) problemas.push('relatório de outra empresa (company_id diferente do esperado)');
  const linhas = Number(rel.criteria.counts_match.rows);
  if (!Number.isFinite(linhas) || linhas < p.volumeMinimo) problemas.push(`volume do ensaio ${Number.isFinite(linhas) ? linhas : 'ausente'} abaixo do mínimo ${p.volumeMinimo} (migracao.dry3.volume_minimo)`);
  if (p.exigirCommitIgual) {
    if (!sameCommit(rel.commit, commitAtual)) problemas.push('relatório de outro commit (diferente do em execução)');
    if (rel.dirty === true) problemas.push('ensaio rodou com árvore alterada (dirty)');
  }
  const gerado = Date.parse(rel.generated_at);
  if (!Number.isNaN(gerado)) {
    if (gerado - agora.getTime() > TOLERANCIA_FUTURO_MS) problemas.push('data de geração no futuro');
    else if (agora.getTime() - gerado > p.validadeHoras * HORA_MS) problemas.push(`relatório com mais de ${p.validadeHoras} h (migracao.dry3.validade_horas)`);
  }
  return problemas;
}

module.exports = { problemasDeVinculo, parametros };
