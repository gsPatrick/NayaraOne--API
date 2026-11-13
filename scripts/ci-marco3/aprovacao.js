#!/usr/bin/env node
'use strict';

/**
 * Etapa 17 (production_approval) da esteira do Marco 3 (Guia M3 §16). NÃO faz deploy: confere o PORTÃO do workflow
 * (.github/workflows/marco3-esteira.yml) antes de registrar a aprovação.
 *   1. O job que roda a etapa 17 usa `environment: marco3-aprovacao` (o GitHub pausa o job até o revisor obrigatório aprovar), só roda
 *      em tag m3-release-* e depende (`needs`) do job de release, que depende da esteira das etapas 1 a 16.
 *   2. Nenhum passo de nenhum job da esteira do Marco 3 dispara deploy de produção (quem publica é o Patrick).
 * O executor (scripts/ci-marco3/executar.js) marca a etapa VERDE dentro do GitHub (o job só começa depois da aprovação) e
 * AGUARDANDO_APROVACAO fora dele.
 */
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const ROOT = path.join(__dirname, '..', '..');
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'marco3-esteira.yml');
const DEPLOY_PRODUCAO = /PRODUCTION_API_DEPLOY_HOOK|deploy[-_ ]?(prod|production)\b/i;
const ambienteDe = (job) => (typeof job.environment === 'string' ? job.environment : job.environment && job.environment.name);

function problemas(workflow = yaml.load(fs.readFileSync(WORKFLOW, 'utf8'))) {
  const out = [];
  const jobs = workflow.jobs || {};
  const aprovacao = jobs['aprovacao-marco3'];
  const release = jobs['release-marco3'];
  if (!aprovacao) return ['o workflow não tem o job aprovacao-marco3'];
  if (!release) out.push('o workflow não tem o job release-marco3');
  if (ambienteDe(aprovacao) !== 'marco3-aprovacao') out.push('o job aprovacao-marco3 não usa environment: marco3-aprovacao (aprovação manual)');
  if (![].concat(aprovacao.needs || []).includes('release-marco3')) out.push('o job aprovacao-marco3 não depende do job release-marco3 (needs)');
  if (release && ![].concat(release.needs || []).includes('esteira-marco3')) out.push('o job release-marco3 não depende da esteira (needs: esteira-marco3)');
  for (const [nome, job] of [['aprovacao-marco3', aprovacao], ['release-marco3', release]]) {
    if (job && !/refs\/tags\/m3-release-/.test(String(job.if || ''))) out.push(`o job ${nome} não está restrito à tag m3-release-*`);
  }
  if (!(aprovacao.steps || []).some((s) => /--de 17 --ate 17/.test(s.run || ''))) out.push('o job aprovacao-marco3 não roda a etapa 17');
  for (const [nome, job] of Object.entries(jobs)) {
    for (const s of job.steps || []) {
      if (DEPLOY_PRODUCAO.test(`${s.name || ''}\n${s.run || ''}\n${JSON.stringify(s.env || {})}`)) out.push(`o passo "${s.name}" do job ${nome} tenta deploy de produção: a esteira nunca publica produção`);
    }
  }
  return out;
}

if (require.main === module) {
  const lista = problemas();
  for (const p of lista) console.error(`REPROVADO ${p}`);
  if (!lista.length) {
    console.log('[production_approval] portão conferido: etapa 17 atrás do environment marco3-aprovacao (revisor obrigatório), só em tag m3-release-*, depois do release e da esteira; nenhum passo publica produção.');
    if (process.env.GITHUB_ACTIONS === 'true') console.log(`[production_approval] aprovação registrada: commit ${process.env.GITHUB_SHA}, execução ${process.env.GITHUB_RUN_ID}. O deploy em produção é feito pelo Patrick.`);
    else console.log('[production_approval] execução fora do GitHub: só o portão foi conferido; nenhuma aprovação dada nem registrada, nenhum deploy feito.');
  }
  process.exit(lista.length ? 1 : 0);
}

module.exports = { problemas };
