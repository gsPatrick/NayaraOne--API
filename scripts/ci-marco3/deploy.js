#!/usr/bin/env node
'use strict';
/**
 * Etapas deploy_DEV e deploy_LAB da esteira do Marco 3 (Guia M3 §16), só em tag m3-release-* (job release-marco3, environment lab):
 * dispara o hook de deploy do ambiente (secret do CI, nunca no repositório) e confere em <URL>/api/version que o commit publicado é o
 * do CI. Sem o secret do ambiente, a etapa fica VERMELHA: nunca finge que publicou. Mesmo desenho de scripts/ci-juridico/deploy.js.
 *
 *   M3_CI_DEV_DEPLOY_HOOK, M3_CI_DEV_URL, M3_CI_LAB_DEPLOY_HOOK, M3_CI_LAB_URL (secrets), GITHUB_SHA
 */
const ambiente = String(process.argv[2] || '').toUpperCase();
if (!['DEV', 'LAB'].includes(ambiente)) { console.error('uso: deploy.js DEV|LAB'); process.exit(2); }
const hook = process.env[`M3_CI_${ambiente}_DEPLOY_HOOK`];
const base = process.env[`M3_CI_${ambiente}_URL`];
const sha = process.env.GITHUB_SHA;
const TENTATIVAS = 60;
const INTERVALO_MS = 10000;

async function main() {
  if (!hook || !base || !sha) {
    console.error(`deploy_${ambiente}: faltam M3_CI_${ambiente}_DEPLOY_HOOK, M3_CI_${ambiente}_URL ou GITHUB_SHA (secrets do environment). Etapa vermelha: nada foi publicado.`);
    process.exit(1);
  }
  const r = await fetch(hook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ref: sha, source: 'esteira-marco3' }) });
  if (!r.ok) { console.error(`deploy_${ambiente}: hook respondeu ${r.status}`); process.exit(1); }
  for (let i = 0; i < TENTATIVAS; i += 1) {
    try {
      const v = await (await fetch(`${base.replace(/\/$/, '')}/api/version`)).json();
      const publicado = (v && (v.commit || (v.data && v.data.commit))) || '';
      if (publicado && sha.startsWith(publicado.slice(0, 7))) { console.log(`deploy_${ambiente}: commit ${publicado} publicado.`); return; }
    } catch (_) { /* ainda publicando */ }
    await new Promise((res) => setTimeout(res, INTERVALO_MS));
  }
  console.error(`deploy_${ambiente}: /api/version não mostrou o commit ${sha} em ${(TENTATIVAS * INTERVALO_MS) / 60000} minutos.`);
  process.exit(1);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
