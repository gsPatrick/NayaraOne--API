'use strict';

const fs = require('node:fs');
const { LeituraError } = require('./erros');
const { daRaiz } = require('./config');
const { problemasDeVinculo } = require('./dry3.vinculo');
const { avaliarAdiamento } = require('./dry3.adiado');
const { verify } = require('../../../src/features/migration-v2/dryrun/dry.signature');

const NOME = 'Migração v2 DRY3';
const CRITERIOS = ['blockers_zero', 'counts_match', 'batches_verified', 'parallel_clean', 'clock_tz_validated', 'rollback_simulated'];

/**
 * Item 1 (M9-D940 §3.1): se o relatório não existe, vale o adiamento registrado (dry3.adiado.js, DI-D940-6); existindo, ele manda e é exigido por inteiro. Lê o relatório EXPORTADO do ensaio real (docs/governance/dry3-report.json, M9-D908), nunca o banco. Exige conclusion APROVADO, os seis critérios
 * verdes, 100% dos lotes VERIFIED, commit e data, o vínculo (empresa, volume mínimo, idade, commit igual ao em execução, árvore limpa; dry3.vinculo.js, R4-L4; caminho por MIGRATION_DRY3_REPORT_PATH) e a assinatura HMAC (dry.signature, chave MIGRATION_DRY3_SIGNING_KEY): sem assinatura ou editado à mão reprova; sem chave = erro de leitura. Arquivo ausente = ensaio não exportado (FALHA); ilegível ou fora do formato = erro de leitura (exit 2).
 */
async function verificar({ cfg }) {
  const nomeArquivo = process.env.MIGRATION_DRY3_REPORT_PATH || cfg.dry3.arquivo;
  const arquivo = daRaiz(nomeArquivo);
  let texto;
  try { texto = fs.readFileSync(arquivo, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') {
      const adiado = avaliarAdiamento(cfg.dry3, NOME);
      if (adiado) return adiado;
      return { nome: NOME, ok: false, motivo: `o relatório do ensaio real não foi exportado (${nomeArquivo}); rode o DRY3 da M9-D908 no ambiente real` };
    }
    throw new LeituraError(`não foi possível ler ${nomeArquivo}: ${e.code || e.message}`);
  }
  let rel;
  try { rel = JSON.parse(texto); } catch (_e) { throw new LeituraError(`${nomeArquivo} não é um JSON válido`); }
  const criterios = rel && rel.criteria;
  if (!rel || typeof rel.conclusion !== 'string' || !criterios || typeof criterios !== 'object' || CRITERIOS.some((c) => !criterios[c] || typeof criterios[c].ok !== 'boolean')) {
    throw new LeituraError(`${nomeArquivo} não tem o formato do relatório DRY3 (conclusion e os seis critérios)`);
  }
  const problemas = [];
  const assinatura = verify(rel);
  if (!assinatura.ok && assinatura.reason === 'KEY_MISSING') throw new LeituraError('MIGRATION_DRY3_SIGNING_KEY ausente ou curta: não é possível conferir a assinatura do relatório DRY3');
  if (!assinatura.ok) problemas.push(assinatura.reason === 'UNSIGNED' ? 'relatório sem assinatura (signature/signature_alg)' : 'assinatura não confere (relatório editado ou chave diferente)');
  if (rel.conclusion !== 'APROVADO') problemas.push(`conclusão ${rel.conclusion}`);
  const vermelhos = CRITERIOS.filter((c) => criterios[c].ok !== true);
  if (vermelhos.length) problemas.push(`critério(s) vermelho(s): ${vermelhos.join(', ')}`);
  const lotes = criterios.batches_verified;
  if (!(lotes.total > 0 && lotes.verified === lotes.total)) problemas.push(`lotes VERIFIED ${lotes.verified}/${lotes.total} (exigido 100%)`);
  if (typeof rel.commit !== 'string' || !rel.commit.trim() || rel.commit === 'unknown') problemas.push('commit do ensaio desconhecido');
  if (typeof rel.generated_at !== 'string' || Number.isNaN(Date.parse(rel.generated_at))) problemas.push('data de geração ausente ou inválida');
  problemas.push(...problemasDeVinculo(rel, cfg.dry3));
  if (problemas.length) return { nome: NOME, ok: false, motivo: problemas.join('; ') };
  return { nome: NOME, ok: true, motivo: `ensaio ${rel.report_id || ''} APROVADO em ${rel.generated_at} (commit ${rel.commit.slice(0, 8)})`.replace('  ', ' ') };
}

module.exports = { verificar, NOME, CRITERIOS };
