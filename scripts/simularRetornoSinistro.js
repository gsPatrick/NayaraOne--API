#!/usr/bin/env node
'use strict';

/**
 * Simula o RETORNO da seguradora de teste (sandbox) para um sinistro já submetido: monta o corpo, assina com
 * HMAC-SHA256 (o mesmo esquema que o webhook público valida) e envia a `POST /v1/procurement/webhooks/insurance`.
 * Só funciona com o provider de seguro "sandbox" e fora de produção; nada real é enviado nem cobrado.
 *
 * Uso:
 *   INSURANCE_WEBHOOK_SECRET='<segredo de teste>' node scripts/simularRetornoSinistro.js \
 *     --url https://<host-da-api>/api --claim-id <uuid-do-sinistro> --status SETTLED --amount 1500.00
 *
 *   --status    SETTLED (liquidado, gera o lançamento a receber no Financeiro) ou REJECTED (recusado, sem lançamento)
 *   --amount    valor da indenização (opcional; sem ele vale o valor do sinistro; acima dele é limitado ao valor do sinistro)
 *   --external-id  em vez de --claim-id, informa o id externo da submissão (`sandbox-claim-insurance-claim:<uuid>`)
 *   --assinatura-errada  envia com assinatura inválida, para provar a recusa 401
 *
 * O segredo vem só do ambiente (nunca por argumento, nunca impresso) e é o mesmo gravado na configuração
 * `procurement.insurance_webhook_secret` da empresa.
 */
const crypto = require('crypto');

const HEADER = 'x-webhook-signature';

function assinar(segredo, corpoBruto) {
  return `sha256=${crypto.createHmac('sha256', segredo).update(corpoBruto).digest('hex')}`;
}

function idExternoDoSandbox(claimId) {
  // submitClaim usa a chave de idempotência `insurance-claim:<id>` e o sandbox devolve `sandbox-claim-<chave>`.
  return `sandbox-claim-insurance-claim:${claimId}`;
}

function arg(nome) {
  const i = process.argv.indexOf(`--${nome}`);
  return i >= 0 ? process.argv[i + 1] : null;
}

async function main() {
  const url = arg('url');
  const status = (arg('status') || 'SETTLED').toUpperCase();
  const claimId = arg('claim-id');
  const externalId = arg('external-id') || (claimId ? idExternoDoSandbox(claimId) : null);
  const amount = arg('amount');
  const segredo = process.env.INSURANCE_WEBHOOK_SECRET;
  if (!url || !externalId) throw new Error('Informe --url e --claim-id (ou --external-id).');
  if (!segredo) throw new Error('Defina INSURANCE_WEBHOOK_SECRET no ambiente (o segredo de teste configurado na empresa).');
  if (!['SETTLED', 'REJECTED'].includes(status)) throw new Error('--status deve ser SETTLED ou REJECTED.');
  if (amount !== null && !(Number.isFinite(Number(amount)) && Number(amount) > 0)) throw new Error('--amount deve ser um número maior que zero.');

  const corpo = { externalSubmissionId: externalId, status };
  if (amount !== null) corpo.settledAmount = Number(amount);
  const corpoBruto = JSON.stringify(corpo);
  const assinatura = process.argv.includes('--assinatura-errada') ? assinar(`${segredo}-errado`, corpoBruto) : assinar(segredo, corpoBruto);

  const destino = `${url.replace(/\/+$/, '')}/v1/procurement/webhooks/insurance`;
  const res = await fetch(destino, { method: 'POST', headers: { 'Content-Type': 'application/json', [HEADER]: assinatura }, body: corpoBruto });
  const texto = await res.text();
  console.log(`HTTP ${res.status}`);
  console.log(texto);
  console.log(`Enviado: id externo ${externalId}, status ${status}${amount !== null ? `, valor ${Number(amount).toFixed(2)}` : ''}${process.argv.includes('--assinatura-errada') ? ' (assinatura propositalmente errada)' : ''}.`);
  if (res.status >= 500) process.exit(1);
}

if (require.main === module) main().catch((e) => { console.error('Falha:', e.message); process.exit(1); });

module.exports = { assinar, idExternoDoSandbox, HEADER };
