#!/usr/bin/env node
'use strict';
/**
 * Etapas deploy_DEV e deploy_LAB da esteira do jurídico (Guia M5 §17), só em tag jur-release-*:
 * dispara o hook de deploy do ambiente (secret do CI, nunca no repositório) e confere em
 * <URL>/api/version que o commit publicado é o do CI. Sem o secret do ambiente, a etapa falha:
 * nunca finge que publicou.
 */
const ambiente = String(process.argv[2] || '').toUpperCase();
if (!['DEV', 'LAB'].includes(ambiente)) { console.error('uso: deploy.js DEV|LAB'); process.exit(2); }
const hook = process.env[`JUR_CI_${ambiente}_DEPLOY_HOOK`];
const base = process.env[`JUR_CI_${ambiente}_URL`];
const sha = process.env.GITHUB_SHA;

async function main() {
  if (!hook || !base || !sha) {
    console.error(`deploy_${ambiente}: faltam JUR_CI_${ambiente}_DEPLOY_HOOK, JUR_CI_${ambiente}_URL ou GITHUB_SHA (secrets do environment). Etapa vermelha: nada foi publicado.`);
    process.exit(1);
  }
  const r = await fetch(hook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ref: sha, source: 'esteira-juridico' }) });
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
