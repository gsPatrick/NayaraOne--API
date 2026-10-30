'use strict';

/**
 * Matriz dos 15 princípios do livro (Guia de Integrações, seção 2, INT-001 a INT-015) e a conferência dela (M9-D253).
 * A fonte é esta lista; docs/integrations/MATRIZ_INT.md é GERADO dela (node scripts/integrationDod.js --gerar-matriz) e o DoD confere que o arquivo
 * é o gerado, que tem as 15 linhas, que cada linha tem demanda dona e que cada teste citado existe de verdade em algum arquivo de teste.
 */
const PRINCIPIOS = Object.freeze([
  { id: 'INT-001', principio: 'Fornecedor atrás de Adapter/Port', demandas: ['D209', 'D210'], testes: ['arquitetura_sdk_apenas_em_providers'] },
  { id: 'INT-002', principio: 'Credenciais em Secret Manager', demandas: ['D202'], testes: ['secret_scan_repositorio_sem_padroes', 'adv_secret_em_log_canario_nao_aparece'] },
  { id: 'INT-003', principio: 'Webhooks autenticados, deduplicados e persistidos antes', demandas: ['D211', 'D212', 'D203'], testes: ['webhook_assinatura_antes_de_parse', 'inbox_unique_provider_event'] },
  { id: 'INT-004', principio: 'Idempotency key / intent local', demandas: ['D214', 'D205'], testes: ['dispatch_chave_derivada_deterministica'] },
  { id: 'INT-005', principio: 'Timeout não é falha definitiva', demandas: ['D215'], testes: ['adv_timeout_outbound_vira_unknown_e_reconcilia'] },
  { id: 'INT-006', principio: 'Retry por classe de erro', demandas: ['D216'], testes: ['retry_validation_nunca_repete', 'retry_auth_sem_renovacao_pausa_connection'] },
  { id: 'INT-007', principio: 'Circuit breaker', demandas: ['D217'], testes: ['circuito_abre_apos_limiar_consecutivo'] },
  { id: 'INT-008', principio: 'Rate limits/quota', demandas: ['D218'], testes: ['quota_429_respeita_retry_after_e_conta_rate_limit'] },
  { id: 'INT-009', principio: 'Payload externo untrusted com schema', demandas: ['D212', 'D213'], testes: ['schema_estrito_rejeita_campo_extra_critico'] },
  { id: 'INT-010', principio: 'Minimização de dados', demandas: ['D219'], testes: ['minimizacao_portal_somente_allowlist'] },
  { id: 'INT-011', principio: 'Health, métricas, alertas, runbook', demandas: ['D223', 'D224'], testes: ['runbooks_existem_para_todos_os_providers'] },
  { id: 'INT-012', principio: 'Falha externa não corrompe domínio', demandas: ['D220'], testes: ['dominio_nao_muda_sem_evento_interno'] },
  { id: 'INT-013', principio: 'Provider swap', demandas: ['D221'], testes: ['adv_provider_swap_mesmo_resultado_contract'] },
  { id: 'INT-014', principio: 'Mudança de API passa por contract tests', demandas: ['D222'], testes: ['contrato_roda_para_cada_versao_suportada'] },
  { id: 'INT-015', principio: 'Fallback/manual contingency', demandas: ['D226', 'D227', 'D228', 'D242'], testes: ['contingencia_encerra_com_tres_checks_ok'] },
]);

const CABECALHO = [
  '# Matriz dos princípios de integração (INT-001 a INT-015)',
  '',
  'Gerado por `node scripts/integrationDod.js --gerar-matriz` a partir de `scripts/int-ci/lib/matrizInt.js`; não edite à mão. O Definition of Done do bloco (`node scripts/integrationDod.js`) confere que este arquivo é o gerado, que tem os 15 princípios do livro, que cada um tem demanda dona e que cada teste citado existe.',
  '',
  '| Princípio (livro) | Demanda dona | Teste que o prova |',
  '|---|---|---|',
];

const cel = (p) => `| ${p.id} ${p.principio} | ${p.demandas.join(', ')} | ${p.testes.map((t) => `\`${t}\``).join(', ')} |`;

function renderMatriz() {
  return `${[...CABECALHO, ...PRINCIPIOS.map(cel)].join('\n')}\n`;
}

/** Lê as linhas da tabela do arquivo: [{ id, principio, demandas, testes }]. */
function lerMatriz(md) {
  const linhas = [];
  for (const l of String(md).split('\n')) {
    const m = /^\|\s*(INT-\d{3})\s+(.*?)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|\s*$/.exec(l);
    if (!m) continue;
    linhas.push({ id: m[1], principio: m[2], demandas: m[3].split(',').map((x) => x.trim()).filter(Boolean), testes: [...m[4].matchAll(/`([^`]+)`/g)].map((x) => x[1]) });
  }
  return linhas;
}

/** Problemas da matriz (lista vazia = íntegra). `existeTeste(nome)` diz se o teste citado existe nos arquivos de teste. */
function problemasDaMatriz(md, existeTeste) {
  const problemas = [];
  const linhas = lerMatriz(md);
  if (linhas.length !== PRINCIPIOS.length) problemas.push(`a matriz tem ${linhas.length} linhas; o livro tem ${PRINCIPIOS.length} princípios (15 princípios, INT-001 a INT-015)`);
  PRINCIPIOS.forEach((p, i) => { if (!linhas[i] || linhas[i].id !== p.id) problemas.push(`a linha ${i + 1} deveria ser ${p.id}`); });
  for (const l of linhas) {
    if (!l.demandas.length || !l.demandas.every((d) => /^D\d{3}$/.test(d))) problemas.push(`${l.id} sem demanda dona válida`);
    if (!l.testes.length) problemas.push(`${l.id} sem teste que o prove`);
    for (const t of l.testes) if (!existeTeste(t)) problemas.push(`${l.id}: o teste ${t} não existe em nenhum arquivo de teste`);
  }
  if (String(md) !== renderMatriz()) problemas.push('o arquivo da matriz não é o gerado (rode node scripts/integrationDod.js --gerar-matriz)');
  return problemas;
}

module.exports = { PRINCIPIOS, renderMatriz, lerMatriz, problemasDaMatriz };
