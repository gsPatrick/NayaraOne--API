# Mapa de segurança — Nayara One (API)

> Gerado por `node scripts/generateSecurityMap.js` em 2026-11-11T05:45:42.280Z, commit `a9f82ea9`.
> Banco consultado: o do `DATABASE_URL` do ambiente (PostgreSQL 17.11 (Homebrew)), transação READ ONLY, só catálogos.
> Nenhum segredo, host ou connection string é impresso. Nenhum endpoint (inclusive MFA) foi chamado.
> Regenerar no estado final antes do fechamento dos Marcos 4/5.

## 1. Resumo

| Item | Valor |
|---|---|
| Tabelas de usuário (fora de pg_catalog/information_schema) | 428 |
| Com RLS habilitado (relrowsecurity) | 417 |
| Com RLS FORCE (relforcerowsecurity) | 416 |
| RLS sem FORCE | 1 |
| RLS sem nenhuma política (nega tudo para não-owner) | 0 |
| Sem RLS | 11 |
| Conexão desta geração é a role de runtime (`nayara_runtime`)? | sim |

## 2. Roles de banco

| Role | rolsuper | rolbypassrls | rolcreaterole | rolcreatedb | rolcanlogin |
|---|---|---|---|---|---|
| nayara_migration | false | false | false | false | false |
| nayara_runtime | false | false | false | false | true |

Requisito: `nayara_runtime` com rolsuper=false e rolbypassrls=false — as políticas RLS valem para a aplicação. A role de migração (DDL) é dona das tabelas; como todas as tabelas com RLS usam FORCE, as políticas valem inclusive para o owner; só superuser ou role com BYPASSRLS as ignoraria (nenhuma das duas é).

## 3. Tabelas sem RLS (exceções)

Tabelas sem RLS são globais/de roteamento (sem `company_id`) ou de infraestrutura (ex.: SequelizeMeta). Conferir cada uma contra `test/rls.catalog.allTables` (lista de exceções documentadas).

| Schema | Tabela |
|---|---|
| core | groups |
| core | permissions |
| core | role_permissions |
| core | users |
| correspondent | external_case_routing |
| correspondent | webhook_pending |
| crm | cart_share_routing |
| finance | bank_payment_provider_routing |
| legal | signature_provider_routing |
| public | SequelizeMeta |
| real_estate | property_addresses |

## 4. RLS por tabela

| Schema | Tabela | RLS | FORCE | Nº políticas | Políticas |
|---|---|---|---|---|---|
| ai | agent_tools | sim | sim | 2 | system_default_read, tenant_isolation |
| ai | agents | sim | sim | 2 | system_default_read, tenant_isolation |
| ai | ai_recommendations | sim | sim | 1 | tenant_isolation |
| ai | ai_runs | sim | sim | 1 | tenant_isolation |
| ai | ai_sources | sim | sim | 1 | tenant_isolation |
| ai | budget_alerts | sim | sim | 1 | tenant_isolation |
| ai | budgets | sim | sim | 1 | tenant_isolation |
| ai | cache_entries | sim | sim | 1 | tenant_isolation |
| ai | chunks | sim | sim | 1 | tenant_isolation |
| ai | evaluation_items | sim | sim | 1 | tenant_isolation |
| ai | evaluations | sim | sim | 1 | tenant_isolation |
| ai | feedback | sim | sim | 1 | tenant_isolation |
| ai | golden_candidates | sim | sim | 1 | tenant_isolation |
| ai | golden_cases | sim | sim | 2 | system_default_read, tenant_isolation |
| ai | ingestions | sim | sim | 1 | tenant_isolation |
| ai | knowledge_entries | sim | sim | 1 | tenant_isolation |
| ai | memories | sim | sim | 1 | tenant_isolation |
| ai | release_gates | sim | sim | 1 | tenant_isolation |
| ai | service_identities | sim | sim | 1 | tenant_isolation |
| ai | tool_calls | sim | sim | 1 | tenant_isolation |
| analytics | access_log | sim | sim | 2 | analytics_insert, analytics_select |
| analytics | alert_definitions | sim | sim | 4 | analytics_delete, analytics_insert, analytics_select, analytics_update |
| analytics | alert_instances | sim | sim | 4 | analytics_delete, analytics_insert, analytics_select, analytics_update |
| analytics | dashboard_definitions | sim | sim | 4 | analytics_delete, analytics_insert, analytics_select, analytics_update |
| analytics | dashboard_widgets | sim | sim | 4 | analytics_delete, analytics_insert, analytics_select, analytics_update |
| analytics | data_quality_checks | sim | sim | 4 | analytics_delete, analytics_insert, analytics_select, analytics_update |
| analytics | executive_briefs | sim | sim | 4 | analytics_delete, analytics_insert, analytics_select, analytics_update |
| analytics | export_jobs | sim | sim | 4 | analytics_delete, analytics_insert, analytics_select, analytics_update |
| analytics | metric_acceptance | sim | sim | 3 | analytics_insert, analytics_select, analytics_update |
| analytics | metric_definitions | sim | sim | 4 | analytics_delete, analytics_insert, analytics_select, analytics_update |
| analytics | metric_snapshot_confirmations | sim | sim | 3 | analytics_insert, analytics_select, analytics_update |
| analytics | metric_snapshots | sim | sim | 4 | analytics_delete, analytics_insert, analytics_select, analytics_update |
| analytics | metric_versions | sim | sim | 4 | analytics_delete, analytics_insert, analytics_select, analytics_update |
| analytics | read_model_refreshes | sim | sim | 4 | analytics_delete, analytics_insert, analytics_select, analytics_update |
| analytics | rm_ai_cost | sim | sim | 4 | analytics_delete, analytics_insert, analytics_select, analytics_update |
| analytics | rm_ai_quality | sim | sim | 4 | analytics_delete, analytics_insert, analytics_select, analytics_update |
| analytics | rm_ai_tool_calls | sim | sim | 4 | analytics_delete, analytics_insert, analytics_select, analytics_update |
| analytics | rm_applied_events | sim | sim | 3 | analytics_delete, analytics_insert, analytics_select |
| analytics | rm_broker_performance | sim | sim | 4 | analytics_delete, analytics_insert, analytics_select, analytics_update |
| analytics | rm_command_events | sim | sim | 4 | analytics_delete, analytics_insert, analytics_select, analytics_update |
| analytics | rm_crm_lead_daily | sim | sim | 4 | analytics_delete, analytics_insert, analytics_select, analytics_update |
| analytics | rm_crm_next_action | sim | sim | 4 | analytics_delete, analytics_insert, analytics_select, analytics_update |
| analytics | rm_crm_opportunity_stage | sim | sim | 4 | analytics_delete, analytics_insert, analytics_select, analytics_update |
| analytics | rm_crm_outcome | sim | sim | 4 | analytics_delete, analytics_insert, analytics_select, analytics_update |
| analytics | rm_crm_visits_proposals | sim | sim | 4 | analytics_delete, analytics_insert, analytics_select, analytics_update |
| analytics | rm_decision_queue | sim | sim | 4 | analytics_delete, analytics_insert, analytics_select, analytics_update |
| analytics | rm_fin_cases_stage | sim | sim | 4 | analytics_delete, analytics_insert, analytics_select, analytics_update |
| analytics | rm_fin_commission | sim | sim | 4 | analytics_delete, analytics_insert, analytics_select, analytics_update |
| analytics | rm_fin_provider_outcome | sim | sim | 4 | analytics_delete, analytics_insert, analytics_select, analytics_update |
| analytics | rm_finance_health | sim | sim | 4 | analytics_delete, analytics_insert, analytics_select, analytics_update |
| analytics | rm_finance_intercompany | sim | sim | 4 | analytics_delete, analytics_insert, analytics_select, analytics_update |
| analytics | rm_finance_sector_margin | sim | sim | 4 | analytics_delete, analytics_insert, analytics_select, analytics_update |
| analytics | rm_inventory_health | sim | sim | 4 | analytics_delete, analytics_insert, analytics_select, analytics_update |
| analytics | rm_legal_cases_risk | sim | sim | 4 | analytics_delete, analytics_insert, analytics_select, analytics_update |
| analytics | rm_legal_deadlines | sim | sim | 4 | analytics_delete, analytics_insert, analytics_select, analytics_update |
| analytics | rm_legal_missing_docs | sim | sim | 4 | analytics_delete, analytics_insert, analytics_select, analytics_update |
| analytics | rm_legal_values | sim | sim | 4 | analytics_delete, analytics_insert, analytics_select, analytics_update |
| analytics | rm_mkt_automation | sim | sim | 4 | analytics_delete, analytics_insert, analytics_select, analytics_update |
| analytics | rm_mkt_campaign_month | sim | sim | 4 | analytics_delete, analytics_insert, analytics_select, analytics_update |
| analytics | rm_mkt_campaigns | sim | sim | 4 | analytics_delete, analytics_insert, analytics_select, analytics_update |
| analytics | rm_mkt_delivery | sim | sim | 4 | analytics_delete, analytics_insert, analytics_select, analytics_update |
| analytics | rm_mkt_frequency | sim | sim | 4 | analytics_delete, analytics_insert, analytics_select, analytics_update |
| analytics | rm_mkt_optout_month | sim | sim | 4 | analytics_delete, analytics_insert, analytics_select, analytics_update |
| analytics | rm_mkt_reviews | sim | sim | 4 | analytics_delete, analytics_insert, analytics_select, analytics_update |
| analytics | rm_postwork_cost | sim | sim | 4 | analytics_delete, analytics_insert, analytics_select, analytics_update |
| analytics | rm_project_cost | sim | sim | 4 | analytics_delete, analytics_insert, analytics_select, analytics_update |
| analytics | rm_project_delays | sim | sim | 4 | analytics_delete, analytics_insert, analytics_select, analytics_update |
| analytics | rm_project_measurements | sim | sim | 4 | analytics_delete, analytics_insert, analytics_select, analytics_update |
| analytics | rm_project_nonconformities | sim | sim | 4 | analytics_delete, analytics_insert, analytics_select, analytics_update |
| analytics | rm_project_occurrences | sim | sim | 4 | analytics_delete, analytics_insert, analytics_select, analytics_update |
| analytics | rm_project_progress | sim | sim | 4 | analytics_delete, analytics_insert, analytics_select, analytics_update |
| analytics | rm_project_waste | sim | sim | 4 | analytics_delete, analytics_insert, analytics_select, analytics_update |
| analytics | rm_property_portfolio | sim | sim | 4 | analytics_delete, analytics_insert, analytics_select, analytics_update |
| analytics | rm_property_price_changes | sim | sim | 4 | analytics_delete, analytics_insert, analytics_select, analytics_update |
| analytics | rm_radar_matches | sim | sim | 4 | analytics_delete, analytics_insert, analytics_select, analytics_update |
| analytics | rm_rental_arrears | sim | sim | 4 | analytics_delete, analytics_insert, analytics_select, analytics_update |
| analytics | rm_rental_contracts | sim | sim | 4 | analytics_delete, analytics_insert, analytics_select, analytics_update |
| analytics | rm_rental_guarantees | sim | sim | 4 | analytics_delete, analytics_insert, analytics_select, analytics_update |
| analytics | rm_rental_inspections_keys | sim | sim | 4 | analytics_delete, analytics_insert, analytics_select, analytics_update |
| analytics | rm_rental_obligations | sim | sim | 4 | analytics_delete, analytics_insert, analytics_select, analytics_update |
| analytics | rm_rental_repasses | sim | sim | 4 | analytics_delete, analytics_insert, analytics_select, analytics_update |
| analytics | rm_rental_satisfaction | sim | sim | 4 | analytics_delete, analytics_insert, analytics_select, analytics_update |
| analytics | rm_rental_tickets | sim | sim | 4 | analytics_delete, analytics_insert, analytics_select, analytics_update |
| analytics | rm_rental_vacancy | sim | sim | 4 | analytics_delete, analytics_insert, analytics_select, analytics_update |
| analytics | rm_stale_aggregates | sim | sim | 4 | analytics_delete, analytics_insert, analytics_select, analytics_update |
| analytics | rm_support_complaints | sim | sim | 4 | analytics_delete, analytics_insert, analytics_select, analytics_update |
| analytics | rm_support_satisfaction | sim | sim | 4 | analytics_delete, analytics_insert, analytics_select, analytics_update |
| analytics | rm_support_sla | sim | sim | 4 | analytics_delete, analytics_insert, analytics_select, analytics_update |
| analytics | rm_tech_auth_failures | sim | sim | 4 | analytics_delete, analytics_insert, analytics_select, analytics_update |
| analytics | rm_tech_availability | sim | sim | 4 | analytics_delete, analytics_insert, analytics_select, analytics_update |
| analytics | rm_tech_blocked_events | sim | sim | 4 | analytics_delete, analytics_insert, analytics_select, analytics_update |
| analytics | rm_tech_freshness | sim | sim | 4 | analytics_delete, analytics_insert, analytics_select, analytics_update |
| analytics | rm_tech_integrations | sim | sim | 4 | analytics_delete, analytics_insert, analytics_select, analytics_update |
| analytics | rm_tech_queues | sim | sim | 4 | analytics_delete, analytics_insert, analytics_select, analytics_update |
| analytics | rm_tool_assets | sim | sim | 4 | analytics_delete, analytics_insert, analytics_select, analytics_update |
| analytics | snapshot_job_runs | sim | sim | 4 | analytics_delete, analytics_insert, analytics_select, analytics_update |
| analytics | tech_signal_log | sim | sim | 3 | tech_signal_delete, tech_signal_insert, tech_signal_select |
| audit | audit_log | sim | sim | 1 | tenant_isolation |
| construction | approval_thresholds | sim | sim | 1 | tenant_isolation |
| construction | budget_lines | sim | sim | 1 | tenant_isolation |
| construction | budgets | sim | sim | 1 | tenant_isolation |
| construction | change_orders | sim | sim | 1 | tenant_isolation |
| construction | daily_materials | sim | sim | 1 | tenant_isolation |
| construction | daily_reports | sim | sim | 1 | tenant_isolation |
| construction | daily_workers | sim | sim | 1 | tenant_isolation |
| construction | loss_records | sim | sim | 1 | tenant_isolation |
| construction | maintenance_cases | sim | sim | 1 | tenant_isolation |
| construction | margin_rules | sim | sim | 1 | tenant_isolation |
| construction | material_requests | sim | sim | 1 | tenant_isolation |
| construction | measurement_items | sim | sim | 1 | tenant_isolation |
| construction | nonconformities | sim | sim | 1 | tenant_isolation |
| construction | project_code_sequences | sim | sim | 1 | tenant_isolation |
| construction | project_stages | sim | sim | 1 | tenant_isolation |
| construction | projects | sim | sim | 1 | tenant_isolation |
| construction | quality_checklist_items | sim | sim | 1 | tenant_isolation |
| construction | stage_dependencies | sim | sim | 1 | tenant_isolation |
| construction | stage_measurements | sim | sim | 1 | tenant_isolation |
| construction | warranty_actions | sim | sim | 1 | tenant_isolation |
| core | companies | sim | sim | 1 | tenant_isolation |
| core | external_refs | sim | sim | 1 | tenant_isolation |
| core | mfa_credentials | sim | sim | 1 | tenant_isolation |
| core | mfa_step_ups | sim | sim | 1 | tenant_isolation |
| core | notifications | sim | sim | 1 | tenant_isolation |
| core | roles | sim | sim | 1 | tenant_isolation |
| core | rule_approval_requests | sim | sim | 1 | tenant_isolation |
| core | rule_approval_steps | sim | sim | 1 | tenant_isolation |
| core | rule_dependencies | sim | sim | 1 | tenant_isolation |
| core | rule_evaluation_log | sim | sim | 1 | tenant_isolation |
| core | rule_exceptions | sim | sim | 1 | tenant_isolation |
| core | rule_publications | sim | sim | 1 | tenant_isolation |
| core | rule_scopes | sim | sim | 1 | tenant_isolation |
| core | rule_simulations | sim | sim | 1 | tenant_isolation |
| core | rule_test_cases | sim | sim | 1 | tenant_isolation |
| core | rule_versions | sim | sim | 1 | tenant_isolation |
| core | rules | sim | sim | 1 | tenant_isolation |
| core | sessions | sim | sim | 1 | tenant_isolation |
| core | substitutions | sim | sim | 1 | tenant_isolation |
| core | system_settings | sim | sim | 1 | tenant_isolation |
| core | tasks | sim | sim | 1 | tenant_isolation |
| core | tenant_settings | sim | sim | 1 | tenant_isolation |
| core | units | sim | sim | 1 | tenant_isolation |
| core | user_memberships | sim | sim | 2 | self_membership_lookup, tenant_isolation |
| correspondent | accounting_export_batches | sim | sim | 1 | tenant_isolation |
| correspondent | accounting_export_lines | sim | sim | 1 | tenant_isolation |
| correspondent | accounting_return_imports | sim | sim | 1 | tenant_isolation |
| correspondent | appraisals | sim | sim | 1 | tenant_isolation |
| correspondent | case_applicants | sim | sim | 1 | tenant_isolation |
| correspondent | case_documents | sim | sim | 1 | tenant_isolation |
| correspondent | case_requirements | sim | sim | 1 | tenant_isolation |
| correspondent | commission_adjustments | sim | sim | 1 | tenant_isolation |
| correspondent | commission_entitlements | sim | sim | 1 | tenant_isolation |
| correspondent | dimob_batches | sim | sim | 1 | tenant_isolation |
| correspondent | dimob_records | sim | sim | 1 | tenant_isolation |
| correspondent | financing_cases | sim | sim | 1 | tenant_isolation |
| correspondent | fiscal_obligations | sim | sim | 1 | tenant_isolation |
| correspondent | fiscal_reconciliations | sim | sim | 1 | tenant_isolation |
| correspondent | integration_errors | sim | sim | 1 | tenant_isolation |
| correspondent | invoice_events | sim | sim | 1 | tenant_isolation |
| correspondent | invoice_requests | sim | sim | 1 | tenant_isolation |
| correspondent | nfse_rps_sequences | sim | sim | 1 | tenant_isolation |
| correspondent | proposals | sim | sim | 1 | tenant_isolation |
| correspondent | provider_accounts | sim | sim | 1 | tenant_isolation |
| correspondent | provider_status_history | sim | sim | 1 | tenant_isolation |
| correspondent | provider_submissions | sim | sim | 1 | tenant_isolation |
| correspondent | simulations | sim | sim | 1 | tenant_isolation |
| correspondent | webhook_inbox | sim | sim | 1 | tenant_isolation |
| crm | cart_versions | sim | sim | 1 | tenant_isolation |
| crm | carts | sim | sim | 1 | tenant_isolation |
| crm | channels | sim | sim | 1 | tenant_isolation |
| crm | conversation_links | sim | sim | 1 | tenant_isolation |
| crm | conversations | sim | sim | 1 | tenant_isolation |
| crm | feedback_cases | sim | sim | 1 | tenant_isolation |
| crm | messages | sim | sim | 1 | tenant_isolation |
| crm | opportunities | sim | sim | 1 | tenant_isolation |
| crm | property_radars | sim | sim | 1 | tenant_isolation |
| crm | proposals | sim | sim | 1 | tenant_isolation |
| crm | radar_matches | sim | sim | 1 | tenant_isolation |
| crm | visits | sim | sim | 1 | tenant_isolation |
| files | quarantine | sim | sim | 1 | tenant_isolation |
| finance | anomaly_cases | sim | sim | 1 | tenant_isolation |
| finance | approval_requests | sim | sim | 1 | tenant_isolation |
| finance | approval_steps | sim | sim | 1 | tenant_isolation |
| finance | bank_accounts | sim | sim | 1 | tenant_isolation |
| finance | bank_statement_entries | sim | sim | 1 | tenant_isolation |
| finance | bank_statement_imports | sim | sim | 1 | tenant_isolation |
| finance | bank_transactions | sim | sim | 1 | tenant_isolation |
| finance | billing_schedule_items | sim | sim | 1 | tenant_isolation |
| finance | billing_schedules | sim | sim | 1 | tenant_isolation |
| finance | budgets_forecasts | sim | sim | 1 | tenant_isolation |
| finance | chart_of_account_versions | sim | sim | 1 | tenant_isolation |
| finance | chart_of_accounts | sim | sim | 1 | tenant_isolation |
| finance | collection_cadence_steps | sim | sim | 1 | tenant_isolation |
| finance | collection_cases | sim | sim | 1 | tenant_isolation |
| finance | commission_installments | sim | sim | 1 | tenant_isolation |
| finance | commissions | sim | sim | 1 | tenant_isolation |
| finance | cost_centers | sim | sim | 1 | tenant_isolation |
| finance | financial_entries | sim | sim | 1 | tenant_isolation |
| finance | guaranteed_rent_contracts | sim | sim | 1 | tenant_isolation |
| finance | intercompany_transfers | sim | sim | 1 | tenant_isolation |
| finance | owner_repasses | sim | sim | 1 | tenant_isolation |
| finance | ownership_transfer_tasks | sim | sim | 1 | tenant_isolation |
| finance | payment_intents | sim | sim | 1 | tenant_isolation |
| finance | period_closure_snapshots | sim | sim | 1 | tenant_isolation |
| finance | period_closures | sim | sim | 1 | tenant_isolation |
| finance | reconciliations | sim | sim | 1 | tenant_isolation |
| finance | rent_adjustments | sim | sim | 1 | tenant_isolation |
| finance | rent_advances | sim | sim | 1 | tenant_isolation |
| finance | result_centers | sim | sim | 1 | tenant_isolation |
| finance | tax_documents | sim | sim | 1 | tenant_isolation |
| finance | utility_accounts | sim | sim | 1 | tenant_isolation |
| finance | utility_reimbursements | sim | sim | 1 | tenant_isolation |
| governance | access_anomalies | sim | sim | 1 | tenant_isolation |
| governance | access_signals | sim | sim | 1 | tenant_isolation |
| governance | api_clients | sim | sim | 2 | api_client_lookup, tenant_isolation |
| governance | api_consumer_usage | sim | sim | 1 | tenant_isolation |
| governance | api_consumers | sim | sim | 2 | api_consumer_client_lookup, tenant_isolation |
| governance | api_deprecations | sim | sim | 1 | tenant_isolation |
| governance | api_scopes | sim | sim | 2 | api_scopes_catalog_write, api_scopes_read |
| governance | bcp_form_templates | sim | sim | 1 | bcp_form_templates_read |
| governance | bcp_payment_pendings | sim | sim | 1 | tenant_isolation |
| governance | bcp_sectors | sim | sim | 1 | bcp_sectors_read |
| governance | budget_alerts | sim | sim | 1 | tenant_isolation |
| governance | budgets | sim | sim | 1 | tenant_isolation |
| governance | bulk_change_items | sim | sim | 1 | tenant_isolation |
| governance | bulk_changes | sim | sim | 1 | tenant_isolation |
| governance | calendar_alert_log | sim | sim | 1 | tenant_isolation |
| governance | calendar_commitments | sim | sim | 1 | tenant_isolation |
| governance | calendar_items | sim | sim | 1 | tenant_isolation |
| governance | classification_review_items | sim | sim | 1 | tenant_isolation |
| governance | config_entries | sim | sim | 1 | tenant_isolation |
| governance | cost_accruals | sim | sim | 1 | tenant_isolation |
| governance | cost_collector_runs | sim | sim | 1 | tenant_isolation |
| governance | cost_ledger | sim | sim | 1 | tenant_isolation |
| governance | cost_read_model | sim | sim | 1 | tenant_isolation |
| governance | cutover_activities | sim | sim | 1 | tenant_isolation |
| governance | cutover_decisions | sim | sim | 1 | tenant_isolation |
| governance | cutover_raci | sim | sim | 1 | tenant_isolation |
| governance | data_classification_registry | sim | sim | 1 | tenant_isolation |
| governance | data_domain_assignments | sim | sim | 1 | tenant_isolation |
| governance | data_domains | sim | sim | 1 | tenant_isolation |
| governance | degradation_actions | sim | sim | 1 | tenant_isolation |
| governance | degradation_policies | sim | sim | 1 | tenant_isolation |
| governance | dlp_policies | sim | sim | 1 | tenant_isolation |
| governance | error_catalog | sim | sim | 2 | error_catalog_read, error_catalog_sync |
| governance | export_jobs | sim | sim | 1 | tenant_isolation |
| governance | external_op_log | sim | sim | 1 | tenant_isolation |
| governance | external_op_types | sim | sim | 1 | tenant_isolation |
| governance | feature_flags | sim | sim | 1 | tenant_isolation |
| governance | field_change_evidence | sim | sim | 1 | tenant_isolation |
| governance | finops_findings | sim | sim | 1 | tenant_isolation |
| governance | flag_alert_log | sim | sim | 1 | tenant_isolation |
| governance | flag_versions | sim | sim | 1 | tenant_isolation |
| governance | idempotency_keys | sim | sim | 1 | tenant_isolation |
| governance | kill_switch_drills | sim | sim | 1 | tenant_isolation |
| governance | legal_hold_targets | sim | sim | 1 | tenant_isolation |
| governance | legal_holds | sim | sim | 1 | tenant_isolation |
| governance | lineage_edges | sim | sim | 1 | tenant_isolation |
| governance | lineage_nodes | sim | sim | 1 | tenant_isolation |
| governance | lineage_seed_state | sim | sim | 1 | tenant_isolation |
| governance | manual_operation_checks | sim | sim | 1 | tenant_isolation |
| governance | manual_operation_imports | sim | sim | 1 | tenant_isolation |
| governance | manual_operations | sim | sim | 1 | tenant_isolation |
| governance | mig_alert_log | sim | sim | 1 | tenant_isolation |
| governance | mig_batch_leaves | sim | sim | 1 | tenant_isolation |
| governance | mig_batches | sim | sim | 1 | tenant_isolation |
| governance | mig_blockers | sim | sim | 1 | tenant_isolation |
| governance | mig_clock_checks | sim | sim | 1 | tenant_isolation |
| governance | mig_counters | sim | sim | 1 | tenant_isolation |
| governance | mig_dry_reports | sim | sim | 1 | tenant_isolation |
| governance | mig_entity_schema | sim | sim | 1 | tenant_isolation |
| governance | mig_event_keys | sim | sim | 1 | tenant_isolation |
| governance | mig_records | sim | sim | 1 | tenant_isolation |
| governance | mig_runs | sim | sim | 1 | tenant_isolation |
| governance | mig_sources | sim | sim | 1 | tenant_isolation |
| governance | parallel_results | sim | sim | 1 | tenant_isolation |
| governance | parallel_rules | sim | sim | 1 | tenant_isolation |
| governance | parallel_runs | sim | sim | 1 | tenant_isolation |
| governance | parallel_windows | sim | sim | 1 | tenant_isolation |
| governance | public_access_counters | sim | sim | 1 | public_counter_writer |
| governance | quality_issues | sim | sim | 1 | tenant_isolation |
| governance | quality_rules | sim | sim | 1 | tenant_isolation |
| governance | quality_scores | sim | sim | 1 | tenant_isolation |
| governance | rate_limit_counters | sim | sim | 1 | rate_limit_writer |
| governance | reconciliations | sim | sim | 1 | tenant_isolation |
| governance | retention_archives | sim | sim | 1 | tenant_isolation |
| governance | retention_policies | sim | sim | 1 | tenant_isolation |
| governance | retention_run_items | sim | sim | 1 | tenant_isolation |
| governance | retention_runs | sim | sim | 1 | tenant_isolation |
| governance | review_queue_items | sim | sim | 1 | tenant_isolation |
| governance | rollback_items | sim | sim | 1 | tenant_isolation |
| governance | share_links | sim | sim | 2 | share_token_lookup, tenant_isolation |
| governance | user_dlp_state | sim | sim | 1 | tenant_isolation |
| integration | alerts | sim | sim | 1 | tenant_isolation |
| integration | connections | sim | sim | 2 | tenant_isolation, webhook_channel_lookup |
| integration | dispatch_attempts | sim | sim | 1 | tenant_isolation |
| integration | dispatches | sim | sim | 1 | tenant_isolation |
| integration | domain_events | sim | sim | 1 | tenant_isolation |
| integration | email_inbound_attachments | sim | sim | 1 | tenant_isolation |
| integration | email_inbound_messages | sim | sim | 1 | tenant_isolation |
| integration | email_message_events | sim | sim | 1 | tenant_isolation |
| integration | email_messages | sim | sim | 1 | tenant_isolation |
| integration | integration_errors | sim | sim | 1 | tenant_isolation |
| integration | integration_inbox | sim | sim | 1 | tenant_isolation |
| integration | outbox_events | sim | sim | 1 | tenant_isolation |
| integration | platform_unknown_webhooks | sim | sim | 1 | platform_only |
| integration | provider_health | sim | sim | 1 | tenant_isolation |
| integration | providers | sim | **não** | 3 | providers_platform_insert, providers_platform_update, providers_read |
| integration | site_pages | sim | sim | 1 | tenant_isolation |
| integration | sync_cursors | sim | sim | 1 | tenant_isolation |
| integration | webhook_inbox | sim | sim | 1 | tenant_isolation |
| inventory | adjustment_proposals | sim | sim | 1 | tenant_isolation |
| inventory | asset_movements | sim | sim | 1 | tenant_isolation |
| inventory | assets | sim | sim | 1 | tenant_isolation |
| inventory | count_items | sim | sim | 1 | tenant_isolation |
| inventory | counts | sim | sim | 1 | tenant_isolation |
| inventory | inventory_items | sim | sim | 1 | tenant_isolation |
| inventory | inventory_movements | sim | sim | 1 | tenant_isolation |
| inventory | locations | sim | sim | 1 | tenant_isolation |
| inventory | loss_cases | sim | sim | 1 | tenant_isolation |
| inventory | maintenance_orders | sim | sim | 1 | tenant_isolation |
| inventory | receipt_items | sim | sim | 1 | tenant_isolation |
| inventory | receipts | sim | sim | 1 | tenant_isolation |
| inventory | requisition_items | sim | sim | 1 | tenant_isolation |
| inventory | requisitions | sim | sim | 1 | tenant_isolation |
| inventory | stock_balances | sim | sim | 1 | tenant_isolation |
| inventory | tool_loans | sim | sim | 1 | tenant_isolation |
| legal | addenda | sim | sim | 1 | tenant_isolation |
| legal | addendum_signatures | sim | sim | 1 | tenant_isolation |
| legal | case_parties | sim | sim | 1 | tenant_isolation |
| legal | case_receivables | sim | sim | 1 | tenant_isolation |
| legal | clause_library | sim | sim | 1 | tenant_isolation |
| legal | clause_versions | sim | sim | 1 | tenant_isolation |
| legal | contract_number_sequences | sim | sim | 1 | tenant_isolation |
| legal | contract_parties | sim | sim | 1 | tenant_isolation |
| legal | contract_requirements | sim | sim | 1 | tenant_isolation |
| legal | contract_template_clauses | sim | sim | 1 | tenant_isolation |
| legal | contract_templates | sim | sim | 1 | tenant_isolation |
| legal | contract_versions | sim | sim | 1 | tenant_isolation |
| legal | contracts | sim | sim | 1 | tenant_isolation |
| legal | evidence_package_access_log | sim | sim | 1 | tenant_isolation |
| legal | evidence_packages | sim | sim | 1 | tenant_isolation |
| legal | guarantees | sim | sim | 1 | tenant_isolation |
| legal | inspection_items | sim | sim | 1 | tenant_isolation |
| legal | inspection_media | sim | sim | 1 | tenant_isolation |
| legal | inspection_signatures | sim | sim | 1 | tenant_isolation |
| legal | inspections | sim | sim | 1 | tenant_isolation |
| legal | insurance_cases | sim | sim | 1 | tenant_isolation |
| legal | key_deliveries | sim | sim | 1 | tenant_isolation |
| legal | lease_obligations | sim | sim | 1 | tenant_isolation |
| legal | legal_cases | sim | sim | 1 | tenant_isolation |
| legal | legal_deadlines | sim | sim | 1 | tenant_isolation |
| legal | notice_versions | sim | sim | 1 | tenant_isolation |
| legal | notices | sim | sim | 1 | tenant_isolation |
| legal | signature_envelopes | sim | sim | 1 | tenant_isolation |
| legal | signatures | sim | sim | 1 | tenant_isolation |
| legal | template_versions | sim | sim | 1 | tenant_isolation |
| marketing | attribution_events | sim | sim | 1 | tenant_isolation |
| marketing | automation_action_receipts | sim | sim | 1 | tenant_isolation |
| marketing | automation_flows | sim | sim | 1 | tenant_isolation |
| marketing | automation_runs | sim | sim | 1 | tenant_isolation |
| marketing | automation_versions | sim | sim | 1 | tenant_isolation |
| marketing | campaign_audience_members | sim | sim | 1 | tenant_isolation |
| marketing | campaign_audiences | sim | sim | 1 | tenant_isolation |
| marketing | campaign_step_deliveries | sim | sim | 1 | tenant_isolation |
| marketing | campaign_steps | sim | sim | 1 | tenant_isolation |
| marketing | campaigns | sim | sim | 1 | tenant_isolation |
| marketing | content_items | sim | sim | 1 | tenant_isolation |
| marketing | content_versions | sim | sim | 1 | tenant_isolation |
| marketing | kill_switch_log | sim | sim | 1 | tenant_isolation |
| marketing | media_authorizations | sim | sim | 1 | tenant_isolation |
| marketing | media_derivatives | sim | sim | 1 | tenant_isolation |
| marketing | publication_jobs | sim | sim | 1 | tenant_isolation |
| marketing | publication_results | sim | sim | 1 | tenant_isolation |
| marketing | reminder_pendings | sim | sim | 1 | tenant_isolation |
| marketing | review_requests | sim | sim | 1 | tenant_isolation |
| marketing | suppression_list | sim | sim | 1 | tenant_isolation |
| marketing | templates | sim | sim | 1 | tenant_isolation |
| marketing | tracking_links | sim | sim | 1 | tenant_isolation |
| people | communication_consents | sim | sim | 1 | tenant_isolation |
| people | file_links | sim | sim | 1 | tenant_isolation |
| people | files | sim | sim | 1 | tenant_isolation |
| people | person_addresses | sim | sim | 1 | tenant_isolation |
| people | person_contacts | sim | sim | 1 | tenant_isolation |
| people | person_documents | sim | sim | 1 | tenant_isolation |
| people | person_roles | sim | sim | 1 | tenant_isolation |
| people | persons | sim | sim | 4 | persons_company_delete, persons_company_insert, persons_company_select, persons_company_update |
| procurement | goods_receipt_items | sim | sim | 1 | tenant_isolation |
| procurement | goods_receipts | sim | sim | 1 | tenant_isolation |
| procurement | insurance_claim_events | sim | sim | 1 | tenant_isolation |
| procurement | insurance_claims | sim | sim | 1 | tenant_isolation |
| procurement | insurance_coverages | sim | sim | 1 | tenant_isolation |
| procurement | insurance_installments | sim | sim | 1 | tenant_isolation |
| procurement | insurance_manual_tasks | sim | sim | 1 | tenant_isolation |
| procurement | insurance_policies | sim | sim | 1 | tenant_isolation |
| procurement | insurance_policy_parties | sim | sim | 1 | tenant_isolation |
| procurement | insurance_policy_versions | sim | sim | 1 | tenant_isolation |
| procurement | insurance_provider_submissions | sim | sim | 1 | tenant_isolation |
| procurement | insurance_renewal_tasks | sim | sim | 1 | tenant_isolation |
| procurement | purchase_order_items | sim | sim | 1 | tenant_isolation |
| procurement | purchase_orders | sim | sim | 1 | tenant_isolation |
| procurement | purchase_request_items | sim | sim | 1 | tenant_isolation |
| procurement | purchase_requests | sim | sim | 1 | tenant_isolation |
| procurement | quotations | sim | sim | 1 | tenant_isolation |
| procurement | receipt_discrepancies | sim | sim | 1 | tenant_isolation |
| procurement | supplier_evaluations | sim | sim | 1 | tenant_isolation |
| procurement | supplier_offer_items | sim | sim | 1 | tenant_isolation |
| procurement | supplier_offers | sim | sim | 1 | tenant_isolation |
| procurement | supplier_qualifications | sim | sim | 1 | tenant_isolation |
| real_estate | portal_listings | sim | sim | 1 | tenant_isolation |
| real_estate | properties | sim | sim | 1 | tenant_isolation |
| real_estate | property_documents | sim | sim | 1 | tenant_isolation |
| real_estate | property_internal_occurrences | sim | sim | 1 | tenant_isolation |
| real_estate | property_media | sim | sim | 1 | tenant_isolation |
| real_estate | property_offers | sim | sim | 1 | tenant_isolation |
| real_estate | property_owners | sim | sim | 1 | tenant_isolation |
| real_estate | property_price_history | sim | sim | 1 | tenant_isolation |
| real_estate | public_property_read_model | sim | sim | 1 | tenant_isolation |

Mecanismo: a aplicação abre transação por requisição (`req.withTenantTransaction`, `src/middlewares/tenant.middleware.js`) e faz `SET LOCAL app.group_id` / `app.company_id`; as políticas comparam a coluna de tenant com `current_setting(..., true)` — sem contexto, nenhuma linha (fail closed).

## 5. RBAC (permissões nas rotas)

Fonte: `requirePermission(...)` em `src/**/*.routes.js` (`src/middlewares/auth.middleware.js`). Permissões efetivas: `core.roles` → `core.role_permissions` → `core.permissions`, resolvidas por membership em `src/features/memberships/effectivePermissions.service.js`.

| Permissão | Nº de rotas | Módulos |
|---|---|---|
| `ai:admin` | 18 | ai, settings |
| `ai:approve` | 2 | ai |
| `ai:evaluate` | 8 | ai |
| `ai:read` | 3 | ai |
| `ai:use` | 5 | ai |
| `audit:read` | 2 | audit |
| `billing:approve` | 3 | billing |
| `billing:cadence:manage` | 1 | billing |
| `billing:create` | 7 | billing |
| `billing:read` | 15 | billing |
| `billing:update` | 8 | billing |
| `companies:create` | 1 | companies |
| `companies:delete` | 1 | companies |
| `companies:read` | 2 | companies |
| `companies:update` | 1 | companies |
| `construction:approve` | 10 | construction |
| `construction:create` | 18 | construction |
| `construction:delete` | 2 | construction |
| `construction:read` | 33 | construction |
| `construction:update` | 19 | construction |
| `correspondent:create` | 17 | correspondent |
| `correspondent:documents:read` | 1 | correspondent |
| `correspondent:fiscal` | 13 | correspondent |
| `correspondent:parameters` | 5 | correspondent |
| `correspondent:read` | 16 | correspondent |
| `crm:dashboard:read` | 1 | crm |
| `crm:feedback:create` | 2 | crm |
| `crm:feedback:read` | 2 | crm |
| `crm:feedback:update` | 4 | crm |
| `crm:messages:create` | 4 | crm |
| `crm:messages:read` | 2 | crm |
| `crm:messages:update` | 2 | crm |
| `crm:opportunities:create` | 2 | crm |
| `crm:opportunities:delete` | 1 | crm |
| `crm:opportunities:export` | 1 | crm |
| `crm:opportunities:read` | 3 | crm |
| `crm:opportunities:reassign` | 1 | crm |
| `crm:opportunities:update` | 5 | crm |
| `crm:proposals:create` | 1 | crm |
| `crm:proposals:read` | 2 | crm |
| `crm:proposals:update` | 1 | crm |
| `crm:tasks:create` | 2 | crm |
| `crm:tasks:read` | 1 | crm |
| `crm:visits:create` | 2 | crm |
| `crm:visits:delete` | 1 | crm |
| `crm:visits:read` | 2 | crm |
| `crm:visits:update` | 1 | crm |
| `finance:approve` | 12 | finance |
| `finance:bankAccounts` | 4 | finance |
| `finance:chartOfAccounts` | 3 | finance |
| `finance:create` | 12 | finance, legal |
| `finance:read` | 37 | finance |
| `finance:reconcile` | 4 | finance |
| `finance:settle` | 19 | correspondent, finance |
| `finance:update` | 10 | finance |
| `governance:classification:manage` | 2 | ai, files |
| `groups:create` | 1 | groups |
| `groups:delete` | 1 | groups |
| `groups:read` | 2 | groups |
| `groups:update` | 1 | groups |
| `integration:manage` | 10 | integrations, settings |
| `integration:platform` | 2 | integrations |
| `integration:read` | 13 | integrations |
| `integration:retry` | 2 | integrations |
| `integration:test` | 1 | integrations |
| `inventory:approve` | 6 | inventory |
| `inventory:create` | 17 | inventory |
| `inventory:read` | 23 | inventory |
| `inventory:update` | 10 | inventory |
| `lease.keys.deliver` | 4 | legal |
| `legal:approve` | 11 | legal |
| `legal:create` | 31 | legal |
| `legal:evidence:export` | 1 | legal |
| `legal:read` | 48 | legal |
| `legal:sign` | 7 | legal |
| `legal:update` | 20 | legal |
| `legal:waive` | 1 | legal |
| `memberships:create` | 1 | memberships |
| `memberships:delete` | 1 | memberships |
| `memberships:read` | 2 | memberships |
| `people:create` | 1 | people |
| `people:delete` | 1 | people |
| `people:read` | 8 | people |
| `people:update` | 14 | people |
| `procurement:approve` | 14 | procurement |
| `procurement:create` | 12 | inventory, procurement |
| `procurement:read` | 16 | procurement |
| `properties:create` | 1 | properties |
| `properties:delete` | 1 | properties |
| `properties:internal` | 2 | properties |
| `properties:read` | 8 | integrations, properties |
| `properties:update` | 14 | integrations, properties |
| `radar:create` | 2 | crm, radar |
| `radar:delete` | 1 | radar |
| `radar:read` | 6 | crm, radar |
| `radar:update` | 1 | radar |
| `roles:create` | 1 | roles |
| `roles:delete` | 1 | roles |
| `roles:read` | 4 | core-governance, roles |
| `roles:update` | 2 | core-governance, roles |
| `settings:read` | 3 | settings |
| `settings:update` | 1 | settings |
| `units:create` | 1 | units |
| `units:delete` | 1 | units |
| `units:read` | 2 | units |
| `units:update` | 1 | units |
| `users:create` | 1 | users |
| `users:delete` | 1 | users |
| `users:read` | 2 | users |
| `users:update` | 3 | users |

## 6. MFA (documentação — nenhum endpoint chamado)

- TOTP; segredo cifrado em repouso com AES-256-GCM e chave dedicada `MFA_ENCRYPTION_KEY` (`src/utils/mfaCrypto.js`), obrigatória, sem fallback.
- Step-up: middleware `requireRecentMfa` (`src/middlewares/auth.middleware.js`) — fail closed: sem MFA habilitado ou sem verificação recente → 403. Também aplicado condicionalmente em `approvals.service.decideApprovalStep` para risco HIGH/CRITICAL.
- Ocorrências de `requireRecentMfa` por arquivo de rotas:

| Arquivo | Ocorrências |
|---|---|
| src/features/ai/agents/agents.routes.js | 1 |
| src/features/core-governance/api-governance/api-governance.routes.js | 2 |
| src/features/core-governance/data-quality/data-quality.routes.js | 1 |
| src/features/core-governance/data-quality/legalHold.routes.js | 1 |
| src/features/core-governance/data-quality/retention.routes.js | 1 |
| src/features/correspondent/correspondent.routes.js | 1 |
| src/features/integrations/contingency/contingency.routes.js | 1 |
| src/features/memberships/memberships.routes.js | 2 |
| src/features/migration-v2/canary/canary.routes.js | 1 |
| src/features/roles/roles.routes.js | 3 |
| src/features/users/users.routes.js | 2 |
| src/modules/finance/presentation/http/finance-official.routes.js | 1 |
| src/modules/finance/presentation/http/finance.routes.js | 14 |
| src/modules/legal/shared/legal.routes.js | 5 |

## 7. Criptografia de arquivos

- Conteúdo de arquivo em disco: AES-256-GCM (`src/utils/fileCrypto.js`), formato `NAYENC1 | IV(12) | TAG(16) | ciphertext`, chave `FILES_ENCRYPTION_KEY` obrigatória (fail closed).
- Integridade: `people.files.checksum_sha256` do conteúdo em claro; adulteração de 1 byte → falha de autenticação GCM e a API responde 409 (provado no drill de restore).
- Arquivos legados sem o marcador são servidos como estão (compatibilidade) — ver comentário do módulo.
- Num restore, sem a mesma `FILES_ENCRYPTION_KEY` os bytes restaurados são ilegíveis (ver RUNBOOK_RESTORE.md).

## 8. Auditoria

- Trilha em `audit.audit_log` (`src/models/AuditLog.js`, `src/features/audit/`), com before/after, ator, empresa e motivo.
- Privilégios da role `nayara_runtime` em `audit.audit_log`:

| Privilégio | Concedido |
|---|---|
| SELECT | true |
| INSERT | true |
| UPDATE | true |
| DELETE | true |
| TRUNCATE | false |

- Triggers no schema `audit`:

  - `audit_log_no_truncate`: `CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit.audit_log FOR EACH STATEMENT EXECUTE FUNCTION audit.audit_log_block_mutation()`
  - `audit_log_no_update_delete`: `CREATE TRIGGER audit_log_no_update_delete BEFORE DELETE OR UPDATE ON audit.audit_log FOR EACH ROW EXECUTE FUNCTION audit.audit_log_block_mutation()`

## 9. Evidências relacionadas

- Drill de restore com RLS + RBAC pós-restore: `npm run restore-drill:legal-full` (ver RUNBOOK_RESTORE.md).
- Testes: `test/rls.catalog.allTables*`, `adversarial.finance`, `adversarial.legal`, `f06.flowSecurity`, `ciTwoTenants*` (rodam contra PostgreSQL real com role NOSUPERUSER/NOBYPASSRLS no CI).

