#!/usr/bin/env node
'use strict';
/**
 * Relatório de contract tests dos adapters (M9-D222): roda os 10 cenários (autenticação, caminho feliz, timeout, 4xx, 5xx, limite, duplicado, resposta malformada, mapeamento de status
 * e saúde) para cada versão suportada de cada adapter com fixtures, na ordem do livro (o messaging-sandbox primeiro), e grava reports/contract/<provider>.json.
 *   node scripts/contractReport.js [provider ...]   -> sandbox determinístico, sem rede (padrão, serve ao CI)
 *   CONTRACT_MODE=live node scripts/contractReport.js ...  -> API real em homologação (opt-in; nunca no CI padrão; adapter sem configuração live é pulado)
 * Saída: 0 tudo verde; 1 algum cenário reprovado ou adapter registrado sem suíte nem pendência declarada; 2 modo live pedido no CI.
 * Não abre conexão de banco: os adapters de laboratório não usam banco.
 */
process.env.PORT = process.env.PORT || '0';
const { registerBuiltInAdapters } = require('../src/features/integrations/adapters');
const contract = require('../src/features/integrations/contract');

async function main() {
  const live = String(process.env.CONTRACT_MODE || '').toLowerCase() === 'live';
  if (live && (process.env.CI === 'true' || process.env.CI === '1')) {
    console.error('INTEGRATION_CONTRACT_LIVE_REFUSED_IN_CI O modo live roda só por decisão de uma pessoa, nunca no CI padrão.');
    return 2;
  }
  registerBuiltInAdapters();
  const pedidos = process.argv.slice(2);
  const alvos = contract.listTargets().filter((t) => pedidos.length === 0 || pedidos.includes(t.providerCode));
  let falhou = false;
  for (const alvo of alvos) {
    if (live) {
      const fixture = contract.loadFixture(alvo.providerCode, 'v1');
      if (!fixture || !fixture.live) { console.log(`PULADO ${alvo.providerCode}: sem configuração live na fixture.`); continue; }
    }
    const report = await contract.runSuite(alvo);
    const arquivo = contract.writeReport(report);
    falhou = falhou || report.status !== 'PASSED';
    console.log(`${report.status} ${report.provider}: ${report.passed}/${report.executions} execuções em ${report.apiVersions.join(', ')} -> ${arquivo.replace(process.cwd(), '.')}`);
  }
  const cobertura = contract.coverage();
  cobertura.pending.forEach((p) => console.log(`PENDENTE ${p.providerCode}: a suíte entra no sprint da ${p.demand}.`));
  if (cobertura.uncovered.length) { console.error(`CONTRACT_ADAPTER_WITHOUT_SUITE ${cobertura.uncovered.join(', ')}`); falhou = true; }
  return falhou ? 1 : 0;
}

main().then((code) => process.exit(code)).catch((err) => { console.error(err.message); process.exit(1); });
