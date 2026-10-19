# Mapa de segurança — Nayara One (API)

> Gerado por `node scripts/generateSecurityMap.js` em 2026-10-19T11:49:16.518Z, commit `3781ecd`.
> Banco consultado: o do `DATABASE_URL` do ambiente (PostgreSQL 17.11 (Debian 17.11-1.pgdg13+2)), transação READ ONLY, só catálogos.
> Nenhum segredo, host ou connection string é impresso. Nenhum endpoint (inclusive MFA) foi chamado.
> Regenerar no estado final antes do fechamento dos Marcos 4/5.

## 1. Resumo

| Item | Valor |
|---|---|
| Tabelas de usuário (fora de pg_catalog/information_schema) | 192 |
| Com RLS habilitado (relrowsecurity) | 182 |
| Com RLS FORCE (relforcerowsecurity) | 182 |
| RLS sem FORCE | 0 |
| RLS sem nenhuma política (nega tudo para não-owner) | 0 |
| Sem RLS | 10 |
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
| crm | cart_share_routing |
| finance | bank_payment_provider_routing |
| legal | signature_provider_routing |
| public | SequelizeMeta |
| real_estate | property_addresses |

## 4. RLS por tabela

| Schema | Tabela | RLS | FORCE | Nº políticas | Políticas |
|---|---|---|---|---|---|
| ai | ai_recommendations | sim | sim | 1 | tenant_isolation |
| ai | ai_runs | sim | sim | 1 | tenant_isolation |
| ai | ai_sources | sim | sim | 1 | tenant_isolation |
| ai | knowledge_entries | sim | sim | 1 | tenant_isolation |
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
| correspondent | commission_entitlements | sim | sim | 1 | tenant_isolation |
| correspondent | dimob_batches | sim | sim | 1 | tenant_isolation |
| correspondent | dimob_records | sim | sim | 1 | tenant_isolation |
| correspondent | financing_cases | sim | sim | 1 | tenant_isolation |
| correspondent | fiscal_obligations | sim | sim | 1 | tenant_isolation |
| correspondent | fiscal_reconciliations | sim | sim | 1 | tenant_isolation |
| correspondent | invoice_events | sim | sim | 1 | tenant_isolation |
| correspondent | invoice_requests | sim | sim | 1 | tenant_isolation |
| correspondent | provider_status_history | sim | sim | 1 | tenant_isolation |
| correspondent | provider_submissions | sim | sim | 1 | tenant_isolation |
| correspondent | simulations | sim | sim | 1 | tenant_isolation |
| correspondent | webhook_inbox | sim | sim | 1 | tenant_isolation |
| crm | cart_versions | sim | sim | 1 | tenant_isolation |
| crm | carts | sim | sim | 1 | tenant_isolation |
| crm | feedback_cases | sim | sim | 1 | tenant_isolation |
| crm | messages | sim | sim | 1 | tenant_isolation |
| crm | opportunities | sim | sim | 1 | tenant_isolation |
| crm | property_radars | sim | sim | 1 | tenant_isolation |
| crm | proposals | sim | sim | 1 | tenant_isolation |
| crm | visits | sim | sim | 1 | tenant_isolation |
| finance | anomaly_cases | sim | sim | 1 | tenant_isolation |
| finance | approval_requests | sim | sim | 1 | tenant_isolation |
| finance | approval_steps | sim | sim | 1 | tenant_isolation |
| finance | bank_accounts | sim | sim | 1 | tenant_isolation |
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
| finance | utility_obligations | sim | sim | 1 | tenant_isolation |
| finance | utility_reimbursements | sim | sim | 1 | tenant_isolation |
| integration | domain_events | sim | sim | 1 | tenant_isolation |
| integration | integration_inbox | sim | sim | 1 | tenant_isolation |
| integration | outbox_events | sim | sim | 1 | tenant_isolation |
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
| legal | contract_amendments | sim | sim | 1 | tenant_isolation |
| legal | contract_clauses | sim | sim | 1 | tenant_isolation |
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
| legal | inspection_signatures | sim | sim | 1 | tenant_isolation |
| legal | inspections | sim | sim | 1 | tenant_isolation |
| legal | insurance_cases | sim | sim | 1 | tenant_isolation |
| legal | key_deliveries | sim | sim | 1 | tenant_isolation |
| legal | legal_case_parties | sim | sim | 1 | tenant_isolation |
| legal | legal_cases | sim | sim | 1 | tenant_isolation |
| legal | legal_deadlines | sim | sim | 1 | tenant_isolation |
| legal | notices | sim | sim | 1 | tenant_isolation |
| legal | signatures | sim | sim | 1 | tenant_isolation |
| people | communication_consents | sim | sim | 1 | tenant_isolation |
| people | file_links | sim | sim | 1 | tenant_isolation |
| people | files | sim | sim | 1 | tenant_isolation |
| people | person_addresses | sim | sim | 1 | tenant_isolation |
| people | person_contacts | sim | sim | 1 | tenant_isolation |
| people | person_documents | sim | sim | 1 | tenant_isolation |
| people | person_roles | sim | sim | 1 | tenant_isolation |
| people | persons | sim | sim | 2 | persons_company_select, persons_company_write |
| procurement | goods_receipt_items | sim | sim | 1 | tenant_isolation |
| procurement | goods_receipts | sim | sim | 1 | tenant_isolation |
| procurement | insurance_claim_events | sim | sim | 1 | tenant_isolation |
| procurement | insurance_claims | sim | sim | 1 | tenant_isolation |
| procurement | insurance_coverages | sim | sim | 1 | tenant_isolation |
| procurement | insurance_installments | sim | sim | 1 | tenant_isolation |
| procurement | insurance_policies | sim | sim | 1 | tenant_isolation |
| procurement | insurance_policy_parties | sim | sim | 1 | tenant_isolation |
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
| real_estate | properties | sim | sim | 1 | tenant_isolation |
| real_estate | property_documents | sim | sim | 1 | tenant_isolation |
| real_estate | property_internal_occurrences | sim | sim | 1 | tenant_isolation |
| real_estate | property_media | sim | sim | 1 | tenant_isolation |
| real_estate | property_offers | sim | sim | 1 | tenant_isolation |
| real_estate | property_owners | sim | sim | 1 | tenant_isolation |
| real_estate | property_price_history | sim | sim | 1 | tenant_isolation |

Mecanismo: a aplicação abre transação por requisição (`req.withTenantTransaction`, `src/middlewares/tenant.middleware.js`) e faz `SET LOCAL app.group_id` / `app.company_id`; as políticas comparam a coluna de tenant com `current_setting(..., true)` — sem contexto, nenhuma linha (fail closed).

## 5. RBAC (permissões nas rotas)

Fonte: `requirePermission(...)` em `src/**/*.routes.js` (`src/middlewares/auth.middleware.js`). Permissões efetivas: `core.roles` → `core.role_permissions` → `core.permissions`, resolvidas por membership em `src/features/memberships/effectivePermissions.service.js`.

| Permissão | Nº de rotas | Módulos |
|---|---|---|
| `audit:read` | 2 | audit |
| `billing:approve` | 3 | billing |
| `billing:create` | 7 | billing |
| `billing:read` | 13 | billing |
| `billing:update` | 7 | billing |
| `companies:create` | 1 | companies |
| `companies:delete` | 1 | companies |
| `companies:read` | 2 | companies |
| `companies:update` | 1 | companies |
| `construction:approve` | 9 | construction |
| `construction:create` | 18 | construction |
| `construction:delete` | 2 | construction |
| `construction:read` | 31 | construction |
| `construction:update` | 18 | construction |
| `correspondent:create` | 10 | correspondent |
| `correspondent:fiscal` | 12 | correspondent |
| `correspondent:read` | 10 | correspondent |
| `crm:dashboard:read` | 1 | crm |
| `crm:feedback:create` | 1 | crm |
| `crm:feedback:read` | 2 | crm |
| `crm:feedback:update` | 2 | crm |
| `crm:messages:create` | 1 | crm |
| `crm:messages:read` | 2 | crm |
| `crm:messages:update` | 1 | crm |
| `crm:opportunities:create` | 1 | crm |
| `crm:opportunities:delete` | 1 | crm |
| `crm:opportunities:export` | 1 | crm |
| `crm:opportunities:read` | 3 | crm |
| `crm:opportunities:update` | 4 | crm |
| `crm:proposals:create` | 1 | crm |
| `crm:proposals:read` | 2 | crm |
| `crm:proposals:update` | 1 | crm |
| `crm:tasks:create` | 1 | crm |
| `crm:tasks:read` | 1 | crm |
| `crm:visits:create` | 1 | crm |
| `crm:visits:delete` | 1 | crm |
| `crm:visits:read` | 2 | crm |
| `crm:visits:update` | 1 | crm |
| `finance:approve` | 11 | finance |
| `finance:bankAccounts` | 4 | finance |
| `finance:chartOfAccounts` | 3 | finance |
| `finance:create` | 10 | finance |
| `finance:read` | 29 | finance |
| `finance:reconcile` | 2 | finance |
| `finance:settle` | 12 | finance |
| `finance:update` | 10 | finance |
| `groups:create` | 1 | groups |
| `groups:delete` | 1 | groups |
| `groups:read` | 2 | groups |
| `groups:update` | 1 | groups |
| `inventory:approve` | 5 | inventory |
| `inventory:create` | 16 | inventory |
| `inventory:read` | 22 | inventory |
| `inventory:update` | 9 | inventory |
| `legal:approve` | 8 | legal |
| `legal:create` | 21 | legal |
| `legal:deliverKeys` | 1 | legal |
| `legal:read` | 36 | legal |
| `legal:sign` | 4 | legal |
| `legal:update` | 16 | legal |
| `legal:waive` | 1 | legal |
| `memberships:create` | 1 | memberships |
| `memberships:delete` | 1 | memberships |
| `memberships:read` | 2 | memberships |
| `people:create` | 1 | people |
| `people:delete` | 1 | people |
| `people:read` | 8 | people |
| `people:update` | 13 | people |
| `procurement:approve` | 10 | procurement |
| `procurement:create` | 12 | inventory, procurement |
| `procurement:read` | 14 | procurement |
| `properties:create` | 1 | properties |
| `properties:delete` | 1 | properties |
| `properties:internal` | 2 | properties |
| `properties:read` | 7 | properties |
| `properties:update` | 11 | properties |
| `radar:create` | 1 | radar |
| `radar:delete` | 1 | radar |
| `radar:read` | 4 | radar |
| `radar:update` | 1 | radar |
| `roles:create` | 1 | roles |
| `roles:delete` | 1 | roles |
| `roles:read` | 3 | roles |
| `roles:update` | 1 | roles |
| `settings:read` | 3 | settings |
| `settings:update` | 1 | settings |
| `units:create` | 1 | units |
| `units:delete` | 1 | units |
| `units:read` | 2 | units |
| `units:update` | 1 | units |
| `users:create` | 1 | users |
| `users:delete` | 1 | users |
| `users:read` | 2 | users |
| `users:update` | 2 | users |

## 6. MFA (documentação — nenhum endpoint chamado)

- TOTP; segredo cifrado em repouso com AES-256-GCM e chave dedicada `MFA_ENCRYPTION_KEY` (`src/utils/mfaCrypto.js`), obrigatória, sem fallback.
- Step-up: middleware `requireRecentMfa` (`src/middlewares/auth.middleware.js`) — fail closed: sem MFA habilitado ou sem verificação recente → 403. Também aplicado condicionalmente em `approvals.service.decideApprovalStep` para risco HIGH/CRITICAL.
- Ocorrências de `requireRecentMfa` por arquivo de rotas:

| Arquivo | Ocorrências |
|---|---|
| src/features/finance/finance.routes.js | 14 |
| src/features/legal/legal.routes.js | 3 |
| src/features/memberships/memberships.routes.js | 2 |
| src/features/roles/roles.routes.js | 3 |
| src/features/users/users.routes.js | 1 |

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
| UPDATE | false |
| DELETE | false |
| TRUNCATE | false |

- Triggers no schema `audit`:

  - `audit_log_no_truncate`: `CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit.audit_log FOR EACH STATEMENT EXECUTE FUNCTION audit.audit_log_block_mutation()`
  - `audit_log_no_update_delete`: `CREATE TRIGGER audit_log_no_update_delete BEFORE DELETE OR UPDATE ON audit.audit_log FOR EACH ROW EXECUTE FUNCTION audit.audit_log_block_mutation()`

## 9. Evidências relacionadas

- Drill de restore com RLS + RBAC pós-restore: `npm run restore-drill:legal-full` (ver RUNBOOK_RESTORE.md).
- Testes: `test/rls.catalog.allTables*`, `adversarial.finance`, `adversarial.legal`, `f06.flowSecurity`, `ciTwoTenants*` (rodam contra PostgreSQL real com role NOSUPERUSER/NOBYPASSRLS no CI).

