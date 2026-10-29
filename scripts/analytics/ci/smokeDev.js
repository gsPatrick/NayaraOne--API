#!/usr/bin/env node
'use strict';

/**
 * M9-D705 etapa 12 — smoke em DEV: cada `GET /analytics/dashboards/<código>` responde 200. O endereço e o token de um usuário de teste vêm do
 * ambiente da promoção (DEV_API_BASE_URL e DEV_SMOKE_TOKEN, segredos do repositório); sem eles a etapa reprova, nunca inventa host. O token nunca
 * é impresso. Os códigos dos painéis vêm do catálogo de painéis do código.
 */
const { DASHBOARD_CODES } = require('../../../src/features/analytics/dashboards/dashboard.catalog');

async function main() {
  const base = process.env.DEV_API_BASE_URL;
  const token = process.env.DEV_SMOKE_TOKEN;
  if (!base || !token) throw new Error('Alvo DEV não configurado (DEV_API_BASE_URL e DEV_SMOKE_TOKEN): a promoção fica bloqueada.');
  const codigos = DASHBOARD_CODES;
  let falhas = 0;
  for (const codigo of codigos) {
    const r = await fetch(`${base.replace(/\/$/, '')}/analytics/dashboards/${encodeURIComponent(codigo)}`, { headers: { Authorization: `Bearer ${token}` } });
    console.log(`GET /analytics/dashboards/${codigo}: ${r.status}`);
    if (r.status !== 200) falhas += 1;
  }
  if (falhas) throw new Error(`${falhas} de ${codigos.length} painel(is) responderam diferente de 200.`);
  console.log(`OK: ${codigos.length} painel(is) responderam 200.`);
}

main().catch((e) => { console.error(`Smoke DEV reprovado: ${e.message}`); process.exitCode = 1; });
