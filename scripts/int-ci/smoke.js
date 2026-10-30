#!/usr/bin/env node
'use strict';

/**
 * Smoke de DEV e LAB (M9-D254, etapas 10 e 11): depois do deploy do ambiente (feito pelo job do workflow, nunca em produção), confere `/health` e roda o `test-connection` de cada provider
 * de laboratório. Endereço e credencial vêm do cofre do CI (INT_CI_DEV_URL / INT_CI_DEV_TOKEN, INT_CI_LAB_URL / INT_CI_LAB_TOKEN); nada disso fica no repositório. Sai com 0 só se tudo respondeu bem.
 *
 *   node scripts/int-ci/smoke.js --ambiente dev|lab        INT_CI_SMOKE_PROVIDERS=messaging-sandbox,signature-sandbox,... (lista do CI; padrão: o provider da tag)
 */
const AMBIENTES = ['dev', 'lab'];

async function chamar(url, opts) {
  const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(Number(process.env.INT_CI_SMOKE_TIMEOUT_MS) || 15000) });
  return { status: r.status, corpo: await r.text() };
}

async function main() {
  const i = process.argv.indexOf('--ambiente');
  const ambiente = i >= 0 ? String(process.argv[i + 1]).toLowerCase() : '';
  if (!AMBIENTES.includes(ambiente)) { console.error('Uso: node scripts/int-ci/smoke.js --ambiente dev|lab'); return 2; }
  const sufixo = ambiente.toUpperCase();
  const base = String(process.env[`INT_CI_${sufixo}_URL`] || '').replace(/\/+$/, '');
  const token = process.env[`INT_CI_${sufixo}_TOKEN`];
  if (!base || !token) { console.error(`Faltam INT_CI_${sufixo}_URL e INT_CI_${sufixo}_TOKEN no cofre do CI.`); return 2; }
  const saude = await chamar(`${base}/health`);
  console.log(`${saude.status === 200 ? 'OK ' : 'FALHA'} ${ambiente} /health -> ${saude.status}`);
  if (saude.status !== 200) return 1;
  const providers = String(process.env.INT_CI_SMOKE_PROVIDERS || process.env.INT_CI_PROVIDER || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (providers.length === 0) { console.error('Informe INT_CI_SMOKE_PROVIDERS ou INT_CI_PROVIDER.'); return 2; }
  let falhou = false;
  for (const provider of providers) {
    const r = await chamar(`${base}/api/v1/admin/integrations/${encodeURIComponent(provider)}/test-connection`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}' });
    const ok = r.status >= 200 && r.status < 300;
    falhou = falhou || !ok;
    console.log(`${ok ? 'OK ' : 'FALHA'} ${ambiente} test-connection ${provider} -> ${r.status}`);
  }
  return falhou ? 1 : 0;
}

main().then((c) => process.exit(c), (err) => { console.error(`smoke recusado: ${err.message}`); process.exit(1); });
