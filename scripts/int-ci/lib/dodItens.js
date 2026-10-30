'use strict';

/**
 * Os 15 itens do Definition of Done do bloco de integrações (livro, seção 20, e Guia §14) e a evidência de cada um (M9-D253).
 * Evidência: { arquivo } existe; { teste } existe como test('<nome>') em algum arquivo de teste; { contratos } relatório de contrato PASSED para cada adapter;
 * { runbooks } runbook de 7 seções para cada provider; { sandboxes } toda família tem sandbox; { adversariais } os 15 itens e 18 nomes do manifesto (D251/D252);
 * { autochecagem } o script da M9-D258 executa e sai com 0. As suítes rodam nas etapas 3 a 8 da esteira (que para na primeira vermelha); o DoD é a etapa 9.
 */
const F = (arquivo) => ({ arquivo });
const T = (teste) => ({ teste });
const I = 'src/features/integrations';
const TD = 'test/marco9/integracoes';

const ITENS = Object.freeze([
  { n: 1, livro: 'Provider registry e connections', demandas: ['D200', 'D201'], evidencias: [F(`${I}/registry/registry.service.js`), F(`${I}/registry/connections.service.js`), F(`${I}/providers/catalog.js`), F('test/integrations/registry.test.js'), F('test/integrations/catalog.test.js')] },
  { n: 2, livro: 'Adapters de todas as famílias com sandbox', demandas: ['D229', 'D243'], evidencias: [{ sandboxes: true }, F(`${I}/registry/adapterRegistry.js`), F(`${TD}/m9d229.sandbox.test.js`), F(`${TD}/m9d243.analytics.test.js`)] },
  { n: 3, livro: 'Inbox, outbox e dispatch', demandas: ['D203', 'D204', 'D205', 'D214'], evidencias: [F(`${I}/inbox`), F(`${I}/dispatch`), F('test/integrations/inbox'), F('test/integrations/dispatch'), T('dispatch_chave_derivada_deterministica')] },
  { n: 4, livro: 'Webhook com autenticação e deduplicação', demandas: ['D211', 'D212', 'D213'], evidencias: [F(`${I}/webhooks`), T('webhook_assinatura_antes_de_parse'), T('inbox_unique_provider_event'), T('schema_estrito_rejeita_campo_extra_critico')] },
  { n: 5, livro: 'Retry e circuit breaker', demandas: ['D216', 'D217'], evidencias: [T('retry_validation_nunca_repete'), T('retry_auth_sem_renovacao_pausa_connection'), T('circuito_abre_apos_limiar_consecutivo'), T('quota_429_respeita_retry_after_e_conta_rate_limit')] },
  { n: 6, livro: 'Gestão de segredos', demandas: ['D202'], evidencias: [F(`${I}/secrets`), F('test/integrations/secrets'), F('scripts/secretScan.js')] },
  { n: 7, livro: 'Health e métricas', demandas: ['D223', 'D224'], evidencias: [F(`${I}/health`), F(`${TD}/m9d223.check.test.js`), F(`${TD}/m9d224.metricas.test.js`)] },
  { n: 8, livro: 'Runbooks de contingência', demandas: ['D223', 'D226', 'D227', 'D228'], evidencias: [{ runbooks: true }, T('runbooks_existem_para_todos_os_providers'), T('contingencia_encerra_com_tres_checks_ok')] },
  { n: 9, livro: 'Contract tests verdes para cada adapter', demandas: ['D222'], evidencias: [{ contratos: true }, T('contrato_roda_para_cada_versao_suportada')] },
  { n: 10, livro: 'Provider swap test', demandas: ['D221'], evidencias: [F(`${I}/swap`), T('adv_provider_swap_mesmo_resultado_contract')] },
  { n: 11, livro: 'Suíte de segurança', demandas: ['D244', 'D245', 'D246', 'D247', 'D248'], evidencias: [F(`${TD}/m9d244.egress.test.js`), F(`${TD}/m9d245.ssrf.test.js`), F(`${TD}/m9d247.quarentena.test.js`), F(`${TD}/m9d248.auditoria.test.js`), T('secret_scan_repositorio_sem_padroes')] },
  { n: 12, livro: '15 itens de falha do livro (18 testes nomeados) verdes', demandas: ['D251', 'D252'], evidencias: [{ adversariais: true }, F('scripts/checkAdversarialNames.js')] },
  { n: 13, livro: 'Redaction', demandas: ['D246'], evidencias: [F('test/integrations/redaction/redaction.canary.test.js'), T('adv_secret_em_log_canario_nao_aparece'), F('scripts/secretScan.js')] },
  { n: 14, livro: 'Homologação específica por provider registrada', demandas: ['D256'], evidencias: [F(`${I}/registry/releaseGate.js`)] },
  { n: 15, livro: 'Autochecagem do livro calculada', demandas: ['D258'], evidencias: [F('scripts/integrationAutocheck.js'), { autochecagem: true }] },
]);

module.exports = { ITENS };
