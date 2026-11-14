#!/usr/bin/env node
'use strict';

/**
 * Estágio 17 (production_approval) da esteira do Financeiro (Guia §17; Caderno §22 "Produção somente após Definition of Done e testes reais"). Não faz
 * deploy: confere o PORTÃO e registra a aprovação.
 *   1. O job do estágio 17 em .github/workflows/financeiro-esteira.yml usa `environment: production` (o GitHub pausa o job até um revisor aprovar) e depende
 *      dos jobs dos estágios 1 a 16 (`needs`), e nenhum passo da esteira financeira dispara deploy de produção.
 *   2. O único deploy de produção do repositório (.github/workflows/test.yml, job deploy-production) também está atrás de `environment: production`.
 *   3. Com GITHUB_ACTIONS, registra quem disparou e o commit aprovado; localmente, registra que só o portão foi conferido (ninguém aprovou nada).
 */
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const ROOT = path.join(__dirname, '..', '..', '..');
const ler = (f) => yaml.load(fs.readFileSync(path.join(ROOT, '.github', 'workflows', f), 'utf8'));
const DEPLOY_PROD = /PRODUCTION_API_DEPLOY_HOOK|deploy[-_ ]?(prod|production)\b/i;

function problemas() {
  const out = [];
  const esteira = ler('financeiro-esteira.yml');
  const jobs = Object.entries(esteira.jobs || {});
  const doEstagio17 = jobs.find(([, j]) => (j.steps || []).some((s) => /^Estágio 17: production_approval$/.test(s.name || '')));
  if (!doEstagio17) out.push('nenhum job da esteira financeira tem o passo "Estágio 17: production_approval"');
  else {
    const [nome, job] = doEstagio17;
    const ambiente = typeof job.environment === 'string' ? job.environment : job.environment && job.environment.name;
    if (ambiente !== 'production') out.push(`o job ${nome} (estágio 17) não usa environment: production (aprovação manual)`);
    const needs = [].concat(job.needs || []);
    if (!needs.length) out.push(`o job ${nome} (estágio 17) não depende dos estágios anteriores (needs)`);
  }
  for (const [nome, job] of jobs) {
    for (const s of job.steps || []) if (DEPLOY_PROD.test(`${s.name || ''}\n${s.run || ''}\n${JSON.stringify(s.env || {})}`)) out.push(`o passo "${s.name}" do job ${nome} tenta deploy de produção: a esteira financeira nunca publica produção`);
  }
  const principal = ler('test.yml');
  for (const [nome, job] of Object.entries(principal.jobs || {})) {
    const publica = (job.steps || []).some((s) => DEPLOY_PROD.test(`${s.name || ''}\n${JSON.stringify(s.env || {})}`));
    const ambiente = typeof job.environment === 'string' ? job.environment : job.environment && job.environment.name;
    if (publica && ambiente !== 'production') out.push(`test.yml: o job ${nome} publica produção sem environment: production`);
  }
  return out;
}

const lista = problemas();
for (const p of lista) console.error(`REPROVADO ${p}`);
if (!lista.length) {
  console.log('[production_approval] portão conferido: estágio 17 atrás de environment "production" (revisor obrigatório), depois dos estágios 1 a 16; nenhum passo da esteira financeira publica produção; o deploy de produção do test.yml também está atrás do mesmo environment.');
  if (process.env.GITHUB_ACTIONS === 'true') console.log(`[production_approval] aprovação registrada: commit ${process.env.GITHUB_SHA}, execução ${process.env.GITHUB_RUN_ID}, disparada por ${process.env.GITHUB_ACTOR}. O deploy em si é feito pelo Patrick.`);
  else console.log('[production_approval] execução local: só o portão foi conferido; nenhuma aprovação foi dada nem registrada, nenhum deploy feito.');
}
process.exit(lista.length ? 1 : 0);
