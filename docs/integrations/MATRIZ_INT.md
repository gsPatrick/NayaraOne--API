# Matriz dos princípios de integração (INT-001 a INT-015)

Gerado por `node scripts/integrationDod.js --gerar-matriz` a partir de `scripts/int-ci/lib/matrizInt.js`; não edite à mão. O Definition of Done do bloco (`node scripts/integrationDod.js`) confere que este arquivo é o gerado, que tem os 15 princípios do livro, que cada um tem demanda dona e que cada teste citado existe.

| Princípio (livro) | Demanda dona | Teste que o prova |
|---|---|---|
| INT-001 Fornecedor atrás de Adapter/Port | D209, D210 | `arquitetura_sdk_apenas_em_providers` |
| INT-002 Credenciais em Secret Manager | D202 | `secret_scan_repositorio_sem_padroes`, `adv_secret_em_log_canario_nao_aparece` |
| INT-003 Webhooks autenticados, deduplicados e persistidos antes | D211, D212, D203 | `webhook_assinatura_antes_de_parse`, `inbox_unique_provider_event` |
| INT-004 Idempotency key / intent local | D214, D205 | `dispatch_chave_derivada_deterministica` |
| INT-005 Timeout não é falha definitiva | D215 | `adv_timeout_outbound_vira_unknown_e_reconcilia` |
| INT-006 Retry por classe de erro | D216 | `retry_validation_nunca_repete`, `retry_auth_sem_renovacao_pausa_connection` |
| INT-007 Circuit breaker | D217 | `circuito_abre_apos_limiar_consecutivo` |
| INT-008 Rate limits/quota | D218 | `quota_429_respeita_retry_after_e_conta_rate_limit` |
| INT-009 Payload externo untrusted com schema | D212, D213 | `schema_estrito_rejeita_campo_extra_critico` |
| INT-010 Minimização de dados | D219 | `minimizacao_portal_somente_allowlist` |
| INT-011 Health, métricas, alertas, runbook | D223, D224 | `runbooks_existem_para_todos_os_providers` |
| INT-012 Falha externa não corrompe domínio | D220 | `dominio_nao_muda_sem_evento_interno` |
| INT-013 Provider swap | D221 | `adv_provider_swap_mesmo_resultado_contract` |
| INT-014 Mudança de API passa por contract tests | D222 | `contrato_roda_para_cada_versao_suportada` |
| INT-015 Fallback/manual contingency | D226, D227, D228, D242 | `contingencia_encerra_com_tres_checks_ok` |
