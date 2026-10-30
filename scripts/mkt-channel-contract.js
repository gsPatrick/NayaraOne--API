#!/usr/bin/env node
'use strict';

// M9-D430 — evidência da suíte de contrato dos adapters de canal do Marketing (9 canais em SANDBOX) e da recusa de produção em canal não liberado.
// Uso: node scripts/mkt-channel-contract.js   (sai 1 se algum canal reprovar). Não toca banco nem rede.
const adapters = require('../src/features/marketing/publications/adapters');

(async () => {
  let failed = 0;
  for (const channel of adapters.CHANNELS) {
    const report = await adapters.runChannelContract(channel);
    const bad = report.results.filter((r) => !r.ok);
    failed += bad.length;
    console.log(`${channel.padEnd(10)} ${report.mode} ${report.ok ? 'OK' : 'FALHOU'} (${report.results.length} verificações)`);
    bad.forEach((r) => console.log(`  - ${r.id}: ${r.error}`));
  }
  try {
    new adapters.RealChannelAdapter('WHATSAPP', {}, {}); // sem a prova de liberação, o adapter real não nasce
  } catch (e) {
    console.log(`Produção sem liberação: ${e.statusCode} ${e.code} - ${e.message}`);
  }
  process.exit(failed ? 1 : 0);
})();
