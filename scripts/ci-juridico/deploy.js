#!/usr/bin/env node
'use strict';
/**
 * Etapas deploy_DEV e deploy_LAB da esteira do jurídico (Guia M5 §17), só em tag jur-release-*:
 * dispara o hook de deploy do ambiente (secret do CI, nunca no repositório) e confere em
 * <URL>/api/version que o commit publicado é o do CI. Sem o secret do ambiente, a etapa falha:
 * nunca finge que publicou. A esteira de Obras (Guia M6 §13, etapa LAB) usa o mesmo script com CI_DEPLOY_PREFIXO=OBR_CI e
 * CI_DEPLOY_ORIGEM=esteira-obras (secrets OBR_CI_LAB_DEPLOY_HOOK e OBR_CI_LAB_URL do environment lab).
 */
const ambiente = String(process.argv[2] || '').toUpperCase();
if (!['DEV', 'LAB'].includes(ambiente)) { console.error('uso: deploy.js DEV|LAB'); process.exit(2); }
const PREFIXO = process.env.CI_DEPLOY_PREFIXO || 'JUR_CI';
const ORIGEM = process.env.CI_DEPLOY_ORIGEM || 'esteira-juridico';
const hook = process.env[`${PREFIXO}_${ambiente}_DEPLOY_HOOK`];
const base = process.env[`${PREFIXO}_${ambiente}_URL`];
const sha = process.env.GITHUB_SHA;

async function main() {
  if (!hook || !base || !sha) {
    console.error(`deploy_${ambiente}: faltam ${PREFIXO}_${ambiente}_DEPLOY_HOOK, ${PREFIXO}_${ambiente}_URL ou GITHUB_SHA (secrets do environment). Etapa vermelha: nada foi publicado.`);
    process.exit(1);
  }
  const r = await fetch(hook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ref: sha, source: ORIGEM }) });
  if (!r.ok) { console.error(`deploy_${ambiente}: hook respondeu ${r.status}`); process.exit(1); }
  for (let i = 0; i < 60; i += 1) {
    try {
      const v = await (await fetch(`${base.replace(/\/$/, '')}/api/version`)).json();
      const publicado = (v && (v.commit || (v.data && v.data.commit))) || '';
      if (publicado && sha.startsWith(publicado.slice(0, 7))) { console.log(`deploy_${ambiente}: commit ${publicado} publicado.`); return; }
    } catch (_) { /* ainda publicando */ }
    await new Promise((res) => setTimeout(res, 10000));
  }
  console.error(`deploy_${ambiente}: /api/version não mostrou o commit ${sha} em 10 minutos.`);
  process.exit(1);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
