# Matriz de permissões da API

Gerada do código por `node scripts/gerarMatrizPermissoes.js --md`. Não editar à mão.

Rotas com permissão exigida: 878. Rotas só com login ou públicas: 44.

Regras gerais: sem token a resposta é 401; com token sem a permissão indicada a resposta é 403 (código `PERMISSION_DENIED`, campo `required`).

## Rotas protegidas por permissão

| Método | Caminho | Permissão exigida | MFA recente |
|---|---|---|---|
| `GET` | `/api/v1/admin/integrations/:provider/health` | `integration:read` | não |
| `POST` | `/api/v1/admin/integrations/:provider/rotate-secret` | `integration:manage` | não |
| `POST` | `/api/v1/admin/integrations/:provider/test-connection` | `integration:test` | não |
| `GET` | `/api/v1/admin/integrations/alerts` | `integration:read` | não |
| `GET` | `/api/v1/admin/integrations/catalog` | `integration:read` | não |
| `POST` | `/api/v1/admin/integrations/connections/:id/release` | `integration:manage` | não |
| `POST` | `/api/v1/admin/integrations/contingency/dispatches/:id/switch` | `integration:manage` | sim |
| `GET` | `/api/v1/admin/integrations/contingency` | `integration:read` | não |
| `GET` | `/api/v1/admin/integrations/dispatches/:id` | `integration:read` | não |
| `POST` | `/api/v1/admin/integrations/email/inbound/:id/link` | `integration:manage` | não |
| `GET` | `/api/v1/admin/integrations/email/inbound/:id` | `integration:read` | não |
| `GET` | `/api/v1/admin/integrations/email/inbound` | `integration:read` | não |
| `GET` | `/api/v1/admin/integrations/errors/:id/impact` | `integration:retry` | não |
| `POST` | `/api/v1/admin/integrations/errors/:id/resolve` | `integration:retry` | não |
| `POST` | `/api/v1/admin/integrations/errors/:id/retry` | `integration:retry` | não |
| `GET` | `/api/v1/admin/integrations/errors` | `integration:read` | não |
| `GET` | `/api/v1/admin/integrations/registry/connections/:id/impact` | `integration:manage` | não |
| `POST` | `/api/v1/admin/integrations/registry/connections/:id/release` | `integration:manage` | não |
| `POST` | `/api/v1/admin/integrations/registry/connections/:id/swap` | `integration:manage` | não |
| `POST` | `/api/v1/admin/integrations/registry/connections/:id/transition` | `integration:manage` | não |
| `GET` | `/api/v1/admin/integrations/registry/connections/:id` | `integration:read` | não |
| `PATCH` | `/api/v1/admin/integrations/registry/connections/:id` | `integration:manage` | não |
| `GET` | `/api/v1/admin/integrations/registry/connections` | `integration:read` | não |
| `POST` | `/api/v1/admin/integrations/registry/connections` | `integration:manage` | não |
| `PATCH` | `/api/v1/admin/integrations/registry/providers/:code` | `integration:platform` | não |
| `GET` | `/api/v1/admin/integrations/registry/providers` | `integration:read` | não |
| `POST` | `/api/v1/admin/integrations/registry/providers` | `integration:platform` | não |
| `GET` | `/api/v1/admin/integrations/registry/release-gate` | `integration:read` | não |
| `GET` | `/api/v1/admin/integrations` | `integration:read` | não |
| `POST` | `/api/v1/ai/agents/:code/chat` | `ai:use` | não |
| `POST` | `/api/v1/ai/agents/:code/versions/:version/activate` | `ai:admin` | não |
| `PUT` | `/api/v1/ai/agents/:code/versions/:version/activate` | `ai:admin` | não |
| `POST` | `/api/v1/ai/agents/:code/versions/:version/homologate` | `ai:evaluate` | não |
| `GET` | `/api/v1/ai/agents/:code/versions/:version/impact` | `ai:admin` | não |
| `POST` | `/api/v1/ai/agents/:code/versions/:version/retire` | `ai:admin` | sim |
| `PUT` | `/api/v1/ai/agents/:code/versions/:version/tools` | `ai:admin` | não |
| `GET` | `/api/v1/ai/agents/:code/versions/:version` | `ai:admin|ai:evaluate` | não |
| `PATCH` | `/api/v1/ai/agents/:code/versions/:version` | `ai:admin` | não |
| `GET` | `/api/v1/ai/agents/:code/versions` | `ai:admin|ai:evaluate` | não |
| `POST` | `/api/v1/ai/agents/:code/versions` | `ai:admin` | não |
| `GET` | `/api/v1/ai/agents` | `ai:use` | não |
| `PUT` | `/api/v1/ai/budgets/:id` | `ai:budget` | não |
| `GET` | `/api/v1/ai/budgets` | `ai:audit|ai:budget` | não |
| `POST` | `/api/v1/ai/budgets` | `ai:budget` | não |
| `POST` | `/api/v1/ai/deterministic/:tool` | `ai:read` | não |
| `GET` | `/api/v1/ai/deterministic` | `ai:read` | não |
| `POST` | `/api/v1/ai/evaluations/:id/homologate` | `ai:evaluate` | não |
| `GET` | `/api/v1/ai/evaluations/:id` | `ai:evaluate` | não |
| `POST` | `/api/v1/ai/evaluations/run` | `ai:evaluate` | não |
| `GET` | `/api/v1/ai/evaluations` | `ai:evaluate` | não |
| `PUT` | `/api/v1/ai/files/:fileId/classification` | `ai:admin`, `governance:classification:manage` | não |
| `POST` | `/api/v1/ai/golden-candidates/:id/approve` | `ai:evaluate` | não |
| `POST` | `/api/v1/ai/golden-candidates/:id/reject` | `ai:evaluate` | não |
| `GET` | `/api/v1/ai/golden-candidates` | `ai:evaluate` | não |
| `GET` | `/api/v1/ai/ingestions/:id` | `ai:use|ai:audit|ai:admin` | não |
| `POST` | `/api/v1/ai/ingestions` | `ai:use|ai:admin` | não |
| `POST` | `/api/v1/ai/knowledge/:id/homologate` | `ai:admin` | não |
| `POST` | `/api/v1/ai/knowledge/:id/revoke` | `ai:admin` | não |
| `GET` | `/api/v1/ai/knowledge/:id` | `ai:admin` | não |
| `PATCH` | `/api/v1/ai/knowledge/:id` | `ai:admin` | não |
| `GET` | `/api/v1/ai/knowledge` | `ai:admin` | não |
| `POST` | `/api/v1/ai/knowledge` | `ai:admin` | não |
| `POST` | `/api/v1/ai/memories/:id/correct` | `ai:use|ai:admin` | não |
| `POST` | `/api/v1/ai/memories/:id/invalidate` | `ai:use|ai:admin` | não |
| `DELETE` | `/api/v1/ai/memories/:id` | `ai:use` | não |
| `GET` | `/api/v1/ai/memories/:id` | `ai:use|ai:audit|ai:admin` | não |
| `GET` | `/api/v1/ai/memories` | `ai:use|ai:audit|ai:admin` | não |
| `POST` | `/api/v1/ai/memories` | `ai:use|ai:admin` | não |
| `POST` | `/api/v1/ai/recommendations/:id/accept` | `ai:approve|ai:read` | não |
| `POST` | `/api/v1/ai/recommendations/:id/reject` | `ai:approve` | não |
| `POST` | `/api/v1/ai/recommendations/:id/reject` | `ai:approve` | não |
| `GET` | `/api/v1/ai/recommendations/:id` | `ai:read|ai:audit` | não |
| `GET` | `/api/v1/ai/recommendations` | `ai:read|ai:audit` | não |
| `GET` | `/api/v1/ai/release-gates` | `ai:admin` | não |
| `POST` | `/api/v1/ai/release-gates` | `ai:admin` | não |
| `POST` | `/api/v1/ai/runs/:id/feedback` | `ai:use` | não |
| `GET` | `/api/v1/ai/runs/:id` | `ai:read|ai:audit` | não |
| `POST` | `/api/v1/ai/runs` | `ai:use` | não |
| `PATCH` | `/api/v1/ai/service-identities/:id` | `ai:admin` | não |
| `GET` | `/api/v1/ai/service-identities` | `ai:admin` | não |
| `POST` | `/api/v1/ai/service-identities` | `ai:admin` | não |
| `GET` | `/api/v1/ai/status` | `ai:read` | não |
| `GET` | `/api/v1/ai/tools` | `ai:admin` | não |
| `GET` | `/api/v1/analytics/access-log` | `analytics:audit:read` | não |
| `POST` | `/api/v1/analytics/alerts/:id/ack` | `analytics:alert:ack` | não |
| `GET` | `/api/v1/analytics/alerts` | `analytics:read` | não |
| `GET` | `/api/v1/analytics/dashboards/:code` | `analytics:read` | não |
| `POST` | `/api/v1/analytics/dashboards/health/thresholds` | `analytics:manage` | não |
| `POST` | `/api/v1/analytics/dashboards` | `analytics:manage` | não |
| `GET` | `/api/v1/analytics/exports/:id/download` | `analytics:export` | não |
| `GET` | `/api/v1/analytics/exports/:id/file` | `analytics:export` | não |
| `POST` | `/api/v1/analytics/exports` | `analytics:export` | não |
| `GET` | `/api/v1/analytics/metrics/:code/drilldown` | `analytics:read` | não |
| `GET` | `/api/v1/analytics/metrics/:code` | `analytics:read` | não |
| `GET` | `/api/v1/api-governance/clients/:id/impact` | `governance:api:manage` | não |
| `POST` | `/api/v1/api-governance/clients/:id/revoke` | `governance:api:manage` | sim |
| `POST` | `/api/v1/api-governance/clients/impact` | `governance:api:manage` | não |
| `GET` | `/api/v1/api-governance/clients` | `governance:api:read` | não |
| `POST` | `/api/v1/api-governance/clients` | `governance:api:manage` | sim |
| `GET` | `/api/v1/api-governance/consumers` | `governance:api:read` | não |
| `POST` | `/api/v1/api-governance/deprecations/:id/cancel` | `governance:api:manage` | não |
| `GET` | `/api/v1/api-governance/deprecations` | `governance:api:read` | não |
| `POST` | `/api/v1/api-governance/deprecations` | `governance:api:manage` | não |
| `GET` | `/api/v1/assets/:id/disposal` | `inventory:read` | não |
| `POST` | `/api/v1/assets/:id/dispose` | `inventory:approve` | não |
| `POST` | `/api/v1/assets/:id/loan` | `inventory:create` | não |
| `GET` | `/api/v1/assets/:id/movements` | `inventory:read` | não |
| `POST` | `/api/v1/assets/:id/transfer` | `inventory:update` | não |
| `PATCH` | `/api/v1/assets/:id` | `inventory:update` | não |
| `GET` | `/api/v1/assets/by-tag/:tag` | `inventory:read` | não |
| `GET` | `/api/v1/assets` | `inventory:read` | não |
| `POST` | `/api/v1/assets` | `inventory:create` | não |
| `GET` | `/api/v1/audit-log/:id` | `audit:read` | não |
| `GET` | `/api/v1/audit-log` | `audit:read` | não |
| `GET` | `/api/v1/bcp/form-templates/:sector/:formType/print` | `governance:bcp:record` | não |
| `GET` | `/api/v1/bcp/form-templates` | `governance:bcp:record` | não |
| `PATCH` | `/api/v1/bcp/manual-operations/:id` | `governance:bcp:record` | não |
| `POST` | `/api/v1/bcp/manual-operations/import` | `governance:bcp:import` | não |
| `GET` | `/api/v1/bcp/manual-operations` | `governance:bcp:record` | não |
| `POST` | `/api/v1/bcp/manual-operations` | `governance:bcp:record` | não |
| `POST` | `/api/v1/bcp/reconciliations/:id/decide` | `governance:bcp:approve` | não |
| `GET` | `/api/v1/bcp/reconciliations` | `governance:bcp:import` | não |
| `GET` | `/api/v1/bcp` | `governance:bcp:record` | não |
| `GET` | `/api/v1/billing/collection-cadence/steps` | `billing:read` | não |
| `POST` | `/api/v1/billing/collection-cadence/versions` | `billing:cadence:manage` | não |
| `GET` | `/api/v1/billing/collection-cadence` | `billing:read` | não |
| `POST` | `/api/v1/billing/collection-cases/:id/agreements` | `billing:update` | não |
| `GET` | `/api/v1/billing/collection-cases/:id` | `billing:read` | não |
| `GET` | `/api/v1/billing/collection-cases` | `billing:read` | não |
| `POST` | `/api/v1/billing/collection-cases` | `billing:create` | não |
| `GET` | `/api/v1/billing/contracts/:contractId/closeout-eligibility` | `billing:read` | não |
| `POST` | `/api/v1/billing/contracts/:contractId/closeout` | `billing:update` | não |
| `POST` | `/api/v1/billing/guaranteed-rent/:id/pay` | `billing:approve` | não |
| `GET` | `/api/v1/billing/guaranteed-rent/:id` | `billing:read` | não |
| `GET` | `/api/v1/billing/guaranteed-rent` | `billing:read` | não |
| `POST` | `/api/v1/billing/guaranteed-rent` | `billing:create` | não |
| `POST` | `/api/v1/billing/ownership-transfer-tasks/:id/complete` | `billing:update` | não |
| `GET` | `/api/v1/billing/rent-adjustments/:id` | `billing:read` | não |
| `GET` | `/api/v1/billing/rent-adjustments` | `billing:read` | não |
| `POST` | `/api/v1/billing/rent-adjustments` | `billing:create` | não |
| `POST` | `/api/v1/billing/rent-advances/:id/accept` | `billing:approve` | não |
| `POST` | `/api/v1/billing/rent-advances/:id/pay` | `billing:approve` | não |
| `POST` | `/api/v1/billing/rent-advances/:id/propose` | `billing:update` | não |
| `POST` | `/api/v1/billing/rent-advances/:id/recover` | `billing:update` | não |
| `GET` | `/api/v1/billing/rent-advances/:id` | `billing:read` | não |
| `GET` | `/api/v1/billing/rent-advances` | `billing:read` | não |
| `POST` | `/api/v1/billing/rent-advances` | `billing:create` | não |
| `POST` | `/api/v1/billing/schedules/:id/payments` | `billing:update` | não |
| `GET` | `/api/v1/billing/schedules/:id` | `billing:read` | não |
| `GET` | `/api/v1/billing/schedules` | `billing:read` | não |
| `POST` | `/api/v1/billing/schedules` | `billing:create` | não |
| `POST` | `/api/v1/billing/utility-accounts` | `billing:create` | não |
| `POST` | `/api/v1/billing/utility-obligations/:id/ownership-transfer` | `billing:update` | não |
| `POST` | `/api/v1/billing/utility-obligations/:id/payments` | `billing:update` | não |
| `GET` | `/api/v1/billing/utility-obligations/:id` | `billing:read` | não |
| `GET` | `/api/v1/billing/utility-obligations` | `billing:read` | não |
| `POST` | `/api/v1/billing/utility-obligations` | `billing:create` | não |
| `GET` | `/api/v1/calendar/commitments/:id` | `governance:calendar:read` | não |
| `PATCH` | `/api/v1/calendar/commitments/:id` | `governance:calendar:read` | não |
| `POST` | `/api/v1/calendar/commitments` | `governance:calendar:read` | não |
| `DELETE` | `/api/v1/calendar/items/:id` | `governance:calendar:read` | não |
| `PATCH` | `/api/v1/calendar/items/:id` | `governance:calendar:read` | não |
| `PUT` | `/api/v1/calendar/items/:id` | `governance:calendar:read` | não |
| `GET` | `/api/v1/calendar` | `governance:calendar:read` | não |
| `PATCH` | `/api/v1/carts/:cartId/items` | `crm:opportunities:update` | não |
| `POST` | `/api/v1/carts/:cartId/share-link` | `crm:opportunities:update` | não |
| `DELETE` | `/api/v1/companies/:id` | `companies:delete` | não |
| `GET` | `/api/v1/companies/:id` | `companies:read` | não |
| `PATCH` | `/api/v1/companies/:id` | `companies:update` | não |
| `GET` | `/api/v1/companies` | `companies:read` | não |
| `POST` | `/api/v1/companies` | `companies:create` | não |
| `POST` | `/api/v1/construction/approval-thresholds` | `construction:update` | não |
| `DELETE` | `/api/v1/construction/budget-lines/:id` | `construction:update` | não |
| `PATCH` | `/api/v1/construction/budget-lines/:id` | `construction:update` | não |
| `POST` | `/api/v1/construction/budgets/:id/approve` | `construction:approve` | não |
| `GET` | `/api/v1/construction/budgets/:id` | `construction:read` | não |
| `POST` | `/api/v1/construction/change-orders/:id/decide` | `construction:approve` | não |
| `GET` | `/api/v1/construction/daily-reports/:id/history` | `construction:read` | não |
| `GET` | `/api/v1/construction/daily-reports/:id/materials` | `construction:read` | não |
| `GET` | `/api/v1/construction/daily-reports/:id/workers` | `construction:read` | não |
| `GET` | `/api/v1/construction/daily-reports/:id` | `construction:read` | não |
| `PATCH` | `/api/v1/construction/daily-reports/:id` | `construction:update` | não |
| `GET` | `/api/v1/construction/dashboard` | `construction:read` | não |
| `POST` | `/api/v1/construction/loss-records/:id/approve` | `construction:approve` | não |
| `POST` | `/api/v1/construction/loss-records/:id/return` | `construction:update` | não |
| `GET` | `/api/v1/construction/maintenance-cases/:id/actions` | `construction:read` | não |
| `POST` | `/api/v1/construction/maintenance-cases/:id/actions` | `construction:update` | não |
| `POST` | `/api/v1/construction/maintenance-cases/:id/resolution/approve` | `construction:approve` | não |
| `POST` | `/api/v1/construction/maintenance-cases/:id/resolution` | `construction:update` | não |
| `DELETE` | `/api/v1/construction/maintenance-cases/:id` | `construction:delete` | não |
| `GET` | `/api/v1/construction/maintenance-cases/:id` | `construction:read` | não |
| `PATCH` | `/api/v1/construction/maintenance-cases/:id` | `construction:update` | não |
| `GET` | `/api/v1/construction/maintenance-cases` | `construction:read` | não |
| `POST` | `/api/v1/construction/maintenance-cases` | `construction:create` | não |
| `GET` | `/api/v1/construction/margin-rules/active` | `construction:read` | não |
| `POST` | `/api/v1/construction/margin-rules/deactivate` | `construction:update` | não |
| `GET` | `/api/v1/construction/margin-rules/versions` | `construction:read` | não |
| `POST` | `/api/v1/construction/margin-rules` | `construction:update` | não |
| `POST` | `/api/v1/construction/material-requests/:id/receive` | `construction:update` | não |
| `POST` | `/api/v1/construction/material-requests/:id/return` | `construction:update` | não |
| `POST` | `/api/v1/construction/measurements/:id/approve` | `construction:approve` | não |
| `POST` | `/api/v1/construction/measurements/:id/decide` | `construction:approve` | não |
| `GET` | `/api/v1/construction/measurements/:id/items` | `construction:read` | não |
| `POST` | `/api/v1/construction/measurements/:id/review` | `construction:update` | não |
| `POST` | `/api/v1/construction/measurements/:id/revise` | `construction:create` | não |
| `POST` | `/api/v1/construction/measurements/:id/submit` | `construction:create` | não |
| `POST` | `/api/v1/construction/nonconformities/:id/close` | `construction:update` | não |
| `GET` | `/api/v1/construction/nonconformities/:id` | `construction:read` | não |
| `GET` | `/api/v1/construction/projects/:id/budget-lines` | `construction:read` | não |
| `POST` | `/api/v1/construction/projects/:id/budget-lines` | `construction:create` | não |
| `GET` | `/api/v1/construction/projects/:id/budgets` | `construction:read` | não |
| `POST` | `/api/v1/construction/projects/:id/budgets` | `construction:create` | não |
| `GET` | `/api/v1/construction/projects/:id/change-orders` | `construction:read` | não |
| `POST` | `/api/v1/construction/projects/:id/change-orders` | `construction:create` | não |
| `POST` | `/api/v1/construction/projects/:id/close-warranty` | `construction:approve` | não |
| `POST` | `/api/v1/construction/projects/:id/daily-logs` | `construction:create` | não |
| `GET` | `/api/v1/construction/projects/:id/daily-reports` | `construction:read` | não |
| `POST` | `/api/v1/construction/projects/:id/daily-reports` | `construction:create` | não |
| `POST` | `/api/v1/construction/projects/:id/deliver` | `construction:approve` | não |
| `GET` | `/api/v1/construction/projects/:id/health` | `construction:read` | não |
| `GET` | `/api/v1/construction/projects/:id/impact` | `construction:update` | não |
| `GET` | `/api/v1/construction/projects/:id/loss-records` | `construction:read` | não |
| `POST` | `/api/v1/construction/projects/:id/loss-records` | `construction:create` | não |
| `GET` | `/api/v1/construction/projects/:id/material-requests` | `construction:read` | não |
| `POST` | `/api/v1/construction/projects/:id/material-requests` | `construction:create` | não |
| `POST` | `/api/v1/construction/projects/:id/measurements` | `construction:create` | não |
| `GET` | `/api/v1/construction/projects/:id/nay-summary/post-obra` | `construction:read` | não |
| `GET` | `/api/v1/construction/projects/:id/nay-summary` | `construction:read` | não |
| `GET` | `/api/v1/construction/projects/:id/nonconformities` | `construction:read` | não |
| `POST` | `/api/v1/construction/projects/:id/nonconformities` | `construction:create` | não |
| `GET` | `/api/v1/construction/projects/:id/post-obra-health` | `construction:read` | não |
| `GET` | `/api/v1/construction/projects/:id/quality-items` | `construction:read` | não |
| `POST` | `/api/v1/construction/projects/:id/quality-items` | `construction:create` | não |
| `GET` | `/api/v1/construction/projects/:id/stages` | `construction:read` | não |
| `POST` | `/api/v1/construction/projects/:id/stages` | `construction:create` | não |
| `POST` | `/api/v1/construction/projects/:id/transition` | `construction:update` | não |
| `DELETE` | `/api/v1/construction/projects/:id` | `construction:delete` | não |
| `GET` | `/api/v1/construction/projects/:id` | `construction:read` | não |
| `PATCH` | `/api/v1/construction/projects/:id` | `construction:update` | não |
| `GET` | `/api/v1/construction/projects` | `construction:read` | não |
| `POST` | `/api/v1/construction/projects` | `construction:create` | não |
| `POST` | `/api/v1/construction/quality-items/:id/check` | `construction:update` | não |
| `DELETE` | `/api/v1/construction/quality-items/:id` | `construction:update` | não |
| `GET` | `/api/v1/construction/settings/cost-basis` | `construction:read` | não |
| `PUT` | `/api/v1/construction/settings/cost-basis` | `construction:approve` | não |
| `GET` | `/api/v1/construction/settings/sla-rule` | `construction:read` | não |
| `POST` | `/api/v1/construction/settings/sla-rule` | `construction:approve` | não |
| `GET` | `/api/v1/construction/stages/:id/dependencies` | `construction:read` | não |
| `POST` | `/api/v1/construction/stages/:id/dependencies` | `construction:create` | não |
| `GET` | `/api/v1/construction/stages/:id/measurements` | `construction:read` | não |
| `POST` | `/api/v1/construction/stages/:id/measurements` | `construction:create` | não |
| `GET` | `/api/v1/construction/stages/:id` | `construction:read` | não |
| `PATCH` | `/api/v1/construction/stages/:id` | `construction:update` | não |
| `POST` | `/api/v1/construction/warranty-cases` | `construction:create` | não |
| `POST` | `/api/v1/contract-versions/:id/approve` | `legal:approve` | não |
| `POST` | `/api/v1/contract-versions/:id/send-signature` | `legal:sign` | não |
| `POST` | `/api/v1/contracts/:contractId/guarantees` | `legal:create` | não |
| `POST` | `/api/v1/contracts/:id/key-delivery` | `legal:create`, `lease.keys.deliver` | não |
| `POST` | `/api/v1/contracts/:id/versions` | `legal:create` | não |
| `POST` | `/api/v1/contracts` | `legal:create` | não |
| `GET` | `/api/v1/crm/dashboard` | `crm:dashboard:read` | não |
| `PATCH` | `/api/v1/crm/feedback-cases/:id/escalate` | `crm:feedback:update` | não |
| `PATCH` | `/api/v1/crm/feedback-cases/:id/resolve` | `crm:feedback:update` | não |
| `DELETE` | `/api/v1/crm/feedback-cases/:id` | `crm:feedback:update` | não |
| `GET` | `/api/v1/crm/feedback-cases/:id` | `crm:feedback:read` | não |
| `GET` | `/api/v1/crm/feedback-cases` | `crm:feedback:read` | não |
| `POST` | `/api/v1/crm/feedback-cases` | `crm:feedback:create` | não |
| `DELETE` | `/api/v1/crm/occurrences/:id` | `crm:feedback:update` | não |
| `POST` | `/api/v1/crm/occurrences` | `crm:feedback:create` | não |
| `POST` | `/api/v1/crm/opportunities/:id/interactions` | `crm:messages:create` | não |
| `POST` | `/api/v1/crm/opportunities/:id/lost` | `crm:opportunities:update` | não |
| `POST` | `/api/v1/crm/opportunities/:id/visits` | `crm:visits:create` | não |
| `GET` | `/api/v1/crm/opportunities/export` | `crm:opportunities:export` | não |
| `POST` | `/api/v1/crm/opportunities/reassign` | `crm:opportunities:reassign` | não |
| `POST` | `/api/v1/crm/opportunities` | `crm:opportunities:create` | não |
| `GET` | `/api/v1/crm/outcome-reasons` | `crm:opportunities:read` | não |
| `PATCH` | `/api/v1/crm/proposals/:id/status` | `crm:proposals:update` | não |
| `GET` | `/api/v1/crm/proposals/:id` | `crm:proposals:read` | não |
| `GET` | `/api/v1/crm/proposals` | `crm:proposals:read` | não |
| `POST` | `/api/v1/crm/proposals` | `crm:proposals:create` | não |
| `GET` | `/api/v1/crm/radars/:id/matches` | `radar:read` | não |
| `POST` | `/api/v1/crm/radars` | `radar:create` | não |
| `GET` | `/api/v1/data-classification/legacy-review` | `governance:data-quality:read` | não |
| `GET` | `/api/v1/data-classification` | `governance:data-quality:read` | não |
| `PUT` | `/api/v1/data-classification` | `governance:classification:manage` | não |
| `POST` | `/api/v1/data-lineage/edges` | `governance:lineage:manage` | não |
| `PUT` | `/api/v1/data-lineage/edges` | `governance:lineage:manage` | não |
| `POST` | `/api/v1/data-lineage/nodes` | `governance:lineage:manage` | não |
| `PUT` | `/api/v1/data-lineage/nodes` | `governance:lineage:manage` | não |
| `GET` | `/api/v1/data-lineage` | `governance:lineage:manage` | não |
| `GET` | `/api/v1/data-quality/bulk-changes/:id` | `governance:data-quality:bulk` | não |
| `POST` | `/api/v1/data-quality/bulk-changes/impact` | `governance:data-quality:bulk` | não |
| `GET` | `/api/v1/data-quality/bulk-changes` | `governance:data-quality:bulk` | não |
| `POST` | `/api/v1/data-quality/bulk-changes` | `governance:data-quality:bulk` | sim |
| `PUT` | `/api/v1/data-quality/domains/:code/assignments` | `governance:data-quality:manage` | não |
| `GET` | `/api/v1/data-quality/domains` | `governance:data-quality:read` | não |
| `POST` | `/api/v1/data-quality/queue/:id/decision` | `governance:data-quality:manage` | não |
| `GET` | `/api/v1/data-quality/queue/:id/impact` | `governance:data-quality:read` | não |
| `GET` | `/api/v1/data-quality/queue` | `governance:data-quality:read` | não |
| `GET` | `/api/v1/data-quality` | `governance:data-quality:read` | não |
| `POST` | `/api/v1/dlp/anomalies/:id/review` | `governance:dlp:admin` | não |
| `GET` | `/api/v1/dlp/anomalies` | `governance:dlp:admin` | não |
| `PUT` | `/api/v1/dlp/policies/:classification/:action` | `governance:dlp:admin` | não |
| `GET` | `/api/v1/dlp/policies` | `governance:dlp:export` | não |
| `GET` | `/api/v1/dlp/share-links/:id/impact` | `governance:dlp:export` | não |
| `POST` | `/api/v1/dlp/share-links/:id/revoke` | `governance:dlp:export` | não |
| `GET` | `/api/v1/dlp/share-links` | `governance:dlp:export` | não |
| `POST` | `/api/v1/dlp/share-links` | `governance:dlp:export` | não |
| `GET` | `/api/v1/dlp` | `governance:dlp:admin` | não |
| `GET` | `/api/v1/exports/:id/download` | `governance:dlp:export` | não |
| `GET` | `/api/v1/exports/:id` | `governance:dlp:export` | não |
| `GET` | `/api/v1/exports/catalog` | `governance:dlp:export` | não |
| `POST` | `/api/v1/exports` | `governance:dlp:export` | não |
| `POST` | `/api/v1/feature-flags/impact` | `governance:flags:manage` | não |
| `GET` | `/api/v1/feature-flags` | `governance:flags:manage` | não |
| `PATCH` | `/api/v1/feature-flags` | `governance:flags:manage` | não |
| `POST` | `/api/v1/feature-flags` | `governance:flags:manage` | não |
| `PUT` | `/api/v1/files/:id/classification` | `governance:classification:manage` | não |
| `POST` | `/api/v1/finance/anomaly-cases/:id/resolve` | `finance:update` | não |
| `GET` | `/api/v1/finance/anomaly-cases` | `finance:read` | não |
| `GET` | `/api/v1/finance/antifraud/parameters` | `settings:read` | não |
| `POST` | `/api/v1/finance/approval-requests/:id/decide` | `finance:approve` | não |
| `GET` | `/api/v1/finance/approval-requests` | `finance:read` | não |
| `POST` | `/api/v1/finance/approval-requests` | `finance:create` | não |
| `POST` | `/api/v1/finance/bank-accounts/:id/block` | `finance:bankAccounts` | não |
| `DELETE` | `/api/v1/finance/bank-accounts/:id` | `finance:bankAccounts` | não |
| `GET` | `/api/v1/finance/bank-accounts/:id` | `finance:read` | não |
| `PATCH` | `/api/v1/finance/bank-accounts/:id` | `finance:bankAccounts` | sim |
| `GET` | `/api/v1/finance/bank-accounts` | `finance:read` | não |
| `POST` | `/api/v1/finance/bank-accounts` | `finance:bankAccounts` | não |
| `POST` | `/api/v1/finance/bank-transactions/:id/auto-reconcile` | `finance:update` | não |
| `GET` | `/api/v1/finance/bank-transactions/:id/reconciliation-suggestions` | `finance:read` | não |
| `POST` | `/api/v1/finance/bank-transactions/import` | `finance:create` | não |
| `GET` | `/api/v1/finance/bank-transactions` | `finance:read` | não |
| `POST` | `/api/v1/finance/bank-transactions` | `finance:create` | não |
| `GET` | `/api/v1/finance/budget-forecasts/compare` | `finance:read` | não |
| `GET` | `/api/v1/finance/budget-forecasts` | `finance:read` | não |
| `POST` | `/api/v1/finance/budget-forecasts` | `finance:create` | não |
| `GET` | `/api/v1/finance/chart-of-accounts/:id/versions` | `finance:read` | não |
| `DELETE` | `/api/v1/finance/chart-of-accounts/:id` | `finance:chartOfAccounts` | não |
| `PATCH` | `/api/v1/finance/chart-of-accounts/:id` | `finance:chartOfAccounts` | não |
| `GET` | `/api/v1/finance/chart-of-accounts` | `finance:read` | não |
| `POST` | `/api/v1/finance/chart-of-accounts` | `finance:chartOfAccounts` | não |
| `POST` | `/api/v1/finance/commission-installments/:installmentId/pay` | `finance:settle` | não |
| `GET` | `/api/v1/finance/commission-rule/versions` | `finance:read` | não |
| `GET` | `/api/v1/finance/commission-rule` | `finance:read` | não |
| `POST` | `/api/v1/finance/commission-rule` | `finance:approve` | sim |
| `GET` | `/api/v1/finance/commissions/:id/adjustments` | `finance:read` | não |
| `POST` | `/api/v1/finance/commissions/:id/cancel` | `finance:update` | não |
| `GET` | `/api/v1/finance/commissions/:id/installments` | `finance:read` | não |
| `GET` | `/api/v1/finance/commissions/:id/release` | `finance:read` | não |
| `GET` | `/api/v1/finance/commissions` | `finance:read` | não |
| `POST` | `/api/v1/finance/commissions` | `finance:create` | não |
| `DELETE` | `/api/v1/finance/cost-centers/:id` | `finance:update` | não |
| `PATCH` | `/api/v1/finance/cost-centers/:id` | `finance:update` | não |
| `GET` | `/api/v1/finance/cost-centers` | `finance:read` | não |
| `POST` | `/api/v1/finance/cost-centers` | `finance:create` | não |
| `POST` | `/api/v1/finance/entries/:id/clear-manual-review` | `finance:approve` | sim |
| `GET` | `/api/v1/finance/entries/:id/impact` | `finance:settle` | não |
| `POST` | `/api/v1/finance/entries/:id/reverse` | `finance:reverse` | sim |
| `POST` | `/api/v1/finance/entries/:id/settle-complement` | `finance:settle` | sim |
| `POST` | `/api/v1/finance/entries/:id/settle-partial` | `finance:settle` | sim |
| `POST` | `/api/v1/finance/entries/:id/settlement-evidence/detach` | `finance:settle` | não |
| `POST` | `/api/v1/finance/entries/:id/settlement-evidence` | `finance:settle` | não |
| `POST` | `/api/v1/finance/entries/:id/settle` | `finance:settle` | sim |
| `GET` | `/api/v1/finance/entries/:id` | `finance:read` | não |
| `PATCH` | `/api/v1/finance/entries/:id` | `finance:update` | não |
| `POST` | `/api/v1/finance/entries/classification-pendings/:id/resolve` | `finance:update` | não |
| `GET` | `/api/v1/finance/entries/classification-pendings` | `finance:read` | não |
| `GET` | `/api/v1/finance/entries` | `finance:read` | não |
| `POST` | `/api/v1/finance/entries` | `finance:create` | não |
| `GET` | `/api/v1/finance/exports/entries` | `finance:read` | não |
| `GET` | `/api/v1/finance/health` | `finance:read` | não |
| `POST` | `/api/v1/finance/intercompany-transfers/:id/approve` | `finance:approve` | sim |
| `POST` | `/api/v1/finance/intercompany-transfers/:id/reconcile` | `finance:reconcile` | não |
| `POST` | `/api/v1/finance/intercompany-transfers/:id/reject` | `finance:approve` | não |
| `GET` | `/api/v1/finance/intercompany-transfers/destination-bank-accounts` | `finance:read` | não |
| `GET` | `/api/v1/finance/intercompany-transfers/destination-companies` | `finance:read` | não |
| `GET` | `/api/v1/finance/intercompany-transfers` | `finance:read` | não |
| `POST` | `/api/v1/finance/intercompany-transfers` | `finance:settle` | sim |
| `POST` | `/api/v1/finance/ledger/:id/reverse` | `finance:reverse` | sim |
| `GET` | `/api/v1/finance/nay/insights` | `finance:read` | não |
| `POST` | `/api/v1/finance/owner-repasses/:id/approve` | `finance:approve` | sim |
| `GET` | `/api/v1/finance/owner-repasses/:id/composition` | `finance:read` | não |
| `POST` | `/api/v1/finance/owner-repasses/:id/pay` | `finance:settle` | não |
| `GET` | `/api/v1/finance/owner-repasses/eligible-sources` | `finance:read` | não |
| `GET` | `/api/v1/finance/owner-repasses` | `finance:read` | não |
| `POST` | `/api/v1/finance/owner-repasses` | `finance:create` | não |
| `POST` | `/api/v1/finance/payment-intents/:id/approve` | `finance:approve` | não |
| `POST` | `/api/v1/finance/payment-intents/:id/cancel` | `finance:update` | não |
| `POST` | `/api/v1/finance/payment-intents/:id/execute` | `finance:settle` | sim |
| `GET` | `/api/v1/finance/payment-intents/:id/impact` | `finance:update` | não |
| `POST` | `/api/v1/finance/payment-intents/:id/reconcile` | `finance:settle` | não |
| `POST` | `/api/v1/finance/payment-intents/:id/resolve-uncertainty` | `finance:approve` | sim |
| `POST` | `/api/v1/finance/payment-intents/:id/submit-to-bank` | `finance:settle` | sim |
| `GET` | `/api/v1/finance/payment-intents` | `finance:read` | não |
| `POST` | `/api/v1/finance/payment-intents` | `finance:create` | não |
| `POST` | `/api/v1/finance/payments/:id/approve` | `finance:approve` | não |
| `POST` | `/api/v1/finance/payments/:id/execute` | `finance:settle` | sim |
| `POST` | `/api/v1/finance/payments/prepare` | `finance:create` | não |
| `GET` | `/api/v1/finance/period-closures/:referenceMonth/preconditions` | `finance:read` | não |
| `POST` | `/api/v1/finance/period-closures/approve` | `finance:approve` | sim |
| `POST` | `/api/v1/finance/period-closures/checks` | `finance:settle` | não |
| `POST` | `/api/v1/finance/period-closures/reopen-requests/:id/approve` | `finance:periodReopen` | sim |
| `POST` | `/api/v1/finance/period-closures/reopen-requests/:id/reject` | `finance:periodReopen` | sim |
| `GET` | `/api/v1/finance/period-closures/reopen-requests` | `finance:read` | não |
| `POST` | `/api/v1/finance/period-closures/reopen` | `finance:periodReopen` | sim |
| `POST` | `/api/v1/finance/period-closures/return-to-open` | `finance:approve` | sim |
| `GET` | `/api/v1/finance/period-closures` | `finance:read` | não |
| `POST` | `/api/v1/finance/period-closures` | `finance:settle` | não |
| `POST` | `/api/v1/finance/periods/:month/close` | `finance:settle` | não |
| `POST` | `/api/v1/finance/reconciliation/:id/confirm` | `finance:reconcile` | não |
| `GET` | `/api/v1/finance/reconciliation/pending` | `finance:read` | não |
| `GET` | `/api/v1/finance/reconciliation/policy` | `finance:read` | não |
| `POST` | `/api/v1/finance/reconciliations/group` | `finance:reconcile` | não |
| `GET` | `/api/v1/finance/reconciliations` | `finance:read` | não |
| `POST` | `/api/v1/finance/reconciliations` | `finance:reconcile` | não |
| `GET` | `/api/v1/finance/reports/group-consolidated` | `finance:read` | não |
| `GET` | `/api/v1/finance/reports/weekly-health` | `finance:read` | não |
| `DELETE` | `/api/v1/finance/result-centers/:id` | `finance:update` | não |
| `PATCH` | `/api/v1/finance/result-centers/:id` | `finance:update` | não |
| `GET` | `/api/v1/finance/result-centers` | `finance:read` | não |
| `POST` | `/api/v1/finance/result-centers` | `finance:create` | não |
| `POST` | `/api/v1/finance/reversal-cases/:id/approve` | `finance:approve` | sim |
| `POST` | `/api/v1/finance/reversal-cases/:id/reject` | `finance:approve` | sim |
| `GET` | `/api/v1/finance/reversal-cases` | `finance:read` | não |
| `GET` | `/api/v1/financing-cases/:id/appraisals` | `correspondent:read` | não |
| `POST` | `/api/v1/financing-cases/:id/appraisals` | `correspondent:create` | não |
| `POST` | `/api/v1/financing-cases/:id/cancel` | `correspondent:create` | não |
| `GET` | `/api/v1/financing-cases/:id/commissions/:entitlementId/adjustments` | `correspondent:read` | não |
| `POST` | `/api/v1/financing-cases/:id/commissions/:entitlementId/chargeback` | `finance:settle` | não |
| `POST` | `/api/v1/financing-cases/:id/commissions/:entitlementId/complete-financial-reversal` | `finance:settle` | não |
| `POST` | `/api/v1/financing-cases/:id/commissions/:entitlementId/confirm` | `correspondent:create` | não |
| `POST` | `/api/v1/financing-cases/:id/commissions/:entitlementId/receive` | `finance:settle` | não |
| `GET` | `/api/v1/financing-cases/:id/commissions` | `correspondent:read` | não |
| `POST` | `/api/v1/financing-cases/:id/commissions` | `correspondent:create` | não |
| `POST` | `/api/v1/financing-cases/:id/documents/send-to-provider` | `correspondent:create` | não |
| `POST` | `/api/v1/financing-cases/:id/documents` | `correspondent:create` | não |
| `POST` | `/api/v1/financing-cases/:id/duplicate-review` | `correspondent:create` | não |
| `POST` | `/api/v1/financing-cases/:id/manual-status` | `correspondent:create` | não |
| `GET` | `/api/v1/financing-cases/:id/nay/compare-simulations` | `correspondent:read` | não |
| `GET` | `/api/v1/financing-cases/:id/nay/summary` | `correspondent:read` | não |
| `GET` | `/api/v1/financing-cases/:id/proposals` | `correspondent:read` | não |
| `POST` | `/api/v1/financing-cases/:id/requirements/:requirementId/dismiss` | `correspondent:create` | não |
| `GET` | `/api/v1/financing-cases/:id/requirements/:requirementId/documents` | `correspondent:documents:read` | não |
| `POST` | `/api/v1/financing-cases/:id/requirements/:requirementId/reject` | `correspondent:create` | não |
| `POST` | `/api/v1/financing-cases/:id/requirements/:requirementId/validate` | `correspondent:create` | não |
| `GET` | `/api/v1/financing-cases/:id/requirements` | `correspondent:read` | não |
| `POST` | `/api/v1/financing-cases/:id/requirements` | `correspondent:create` | não |
| `GET` | `/api/v1/financing-cases/:id/simulations` | `correspondent:read` | não |
| `POST` | `/api/v1/financing-cases/:id/simulations` | `correspondent:create` | não |
| `GET` | `/api/v1/financing-cases/:id/status` | `correspondent:read` | não |
| `POST` | `/api/v1/financing-cases/:id/submissions/:submissionId/acknowledge-unknown` | `correspondent:create` | não |
| `GET` | `/api/v1/financing-cases/:id/submissions` | `correspondent:read` | não |
| `POST` | `/api/v1/financing-cases/:id/submissions` | `correspondent:create` | não |
| `GET` | `/api/v1/financing-cases/:id` | `correspondent:read` | não |
| `GET` | `/api/v1/financing-cases/duplicates/pending` | `correspondent:read` | não |
| `GET` | `/api/v1/financing-cases/nay/stalled` | `correspondent:read` | não |
| `GET` | `/api/v1/financing-cases` | `correspondent:read` | não |
| `POST` | `/api/v1/financing-cases` | `correspondent:create` | não |
| `PATCH` | `/api/v1/finops/budgets/:id` | `governance:finops:manage` | não |
| `GET` | `/api/v1/finops/budgets` | `governance:finops:read` | não |
| `POST` | `/api/v1/finops/budgets` | `governance:finops:manage` | não |
| `GET` | `/api/v1/finops/degradation-policies` | `governance:finops:read` | não |
| `PUT` | `/api/v1/finops/degradation-policies` | `governance:finops:manage` | não |
| `GET` | `/api/v1/finops/health` | `governance:finops:read` | não |
| `POST` | `/api/v1/fiscal/dimob-batches/:id/close` | `correspondent:fiscal` | não |
| `GET` | `/api/v1/fiscal/dimob-batches/:id/file` | `correspondent:fiscal` | não |
| `GET` | `/api/v1/fiscal/dimob-batches/:id/records` | `correspondent:fiscal` | não |
| `GET` | `/api/v1/fiscal/dimob-batches` | `correspondent:fiscal` | não |
| `POST` | `/api/v1/fiscal/dimob-batches` | `correspondent:fiscal` | não |
| `POST` | `/api/v1/fiscal/export-batches/:id/return` | `correspondent:fiscal` | não |
| `GET` | `/api/v1/fiscal/export-batches/:id` | `correspondent:fiscal` | não |
| `GET` | `/api/v1/fiscal/export-batches` | `correspondent:fiscal` | não |
| `POST` | `/api/v1/fiscal/export-batches` | `correspondent:fiscal` | não |
| `GET` | `/api/v1/fiscal/export-candidates` | `correspondent:fiscal` | não |
| `POST` | `/api/v1/fiscal/export-lines/:id/adjust` | `correspondent:fiscal` | não |
| `POST` | `/api/v1/fiscal/invoices/:id/cancel` | `correspondent:fiscal` | sim |
| `POST` | `/api/v1/fiscal/invoices/:id/check-status` | `correspondent:fiscal` | não |
| `GET` | `/api/v1/fiscal/invoices/:id/events` | `correspondent:fiscal` | não |
| `GET` | `/api/v1/fiscal/invoices/:id/pdf` | `correspondent:fiscal` | não |
| `GET` | `/api/v1/fiscal/invoices/:id/xml` | `correspondent:fiscal` | não |
| `GET` | `/api/v1/fiscal/invoices` | `correspondent:fiscal` | não |
| `POST` | `/api/v1/fiscal/invoices` | `correspondent:fiscal` | não |
| `POST` | `/api/v1/fiscal/obligations/:id/complete` | `correspondent:fiscal` | não |
| `PUT` | `/api/v1/fiscal/obligations/:id/due-date` | `correspondent:fiscal` | não |
| `GET` | `/api/v1/fiscal/obligations` | `correspondent:fiscal` | não |
| `POST` | `/api/v1/fiscal/obligations` | `correspondent:fiscal` | não |
| `POST` | `/api/v1/fiscal/reconciliations/:id/resolve` | `correspondent:fiscal` | não |
| `POST` | `/api/v1/fiscal/reconciliations/run` | `correspondent:fiscal` | não |
| `GET` | `/api/v1/fiscal/reconciliations` | `correspondent:fiscal` | não |
| `POST` | `/api/v1/governance/permissions/apply-default` | `roles:update` | não |
| `GET` | `/api/v1/governance/permissions` | `roles:read` | não |
| `DELETE` | `/api/v1/groups/:id` | `groups:delete` | não |
| `GET` | `/api/v1/groups/:id` | `groups:read` | não |
| `PATCH` | `/api/v1/groups/:id` | `groups:update` | não |
| `GET` | `/api/v1/groups` | `groups:read` | não |
| `POST` | `/api/v1/groups` | `groups:create` | não |
| `POST` | `/api/v1/inspections/:id/sign` | `legal:update` | sim |
| `POST` | `/api/v1/inspections` | `legal:create` | não |
| `POST` | `/api/v1/integration-errors/:id/resolve` | `correspondent:create` | não |
| `GET` | `/api/v1/integration-errors` | `correspondent:read` | não |
| `POST` | `/api/v1/inventory/adjustment-proposals/:id/decide` | `inventory:approve` | não |
| `GET` | `/api/v1/inventory/adjustment-proposals` | `inventory:read` | não |
| `POST` | `/api/v1/inventory/adjustment-proposals` | `inventory:create` | não |
| `GET` | `/api/v1/inventory/adjustment-risk-rule` | `inventory:read` | não |
| `POST` | `/api/v1/inventory/adjustment-risk-rule` | `inventory:approve` | não |
| `POST` | `/api/v1/inventory/count-items/:countItemId/apply-adjustment` | `inventory:approve` | não |
| `POST` | `/api/v1/inventory/counts/:id/complete` | `inventory:create` | não |
| `POST` | `/api/v1/inventory/counts/:id/items` | `inventory:create` | não |
| `GET` | `/api/v1/inventory/counts/:id` | `inventory:read` | não |
| `GET` | `/api/v1/inventory/counts` | `inventory:read` | não |
| `POST` | `/api/v1/inventory/counts` | `inventory:create` | não |
| `GET` | `/api/v1/inventory/items/:id/balances` | `inventory:read` | não |
| `GET` | `/api/v1/inventory/items/:id/min-stock-rule` | `inventory:read` | não |
| `POST` | `/api/v1/inventory/items/:id/min-stock-rule` | `inventory:update` | não |
| `POST` | `/api/v1/inventory/items/:id/status` | `inventory:update` | não |
| `GET` | `/api/v1/inventory/items/:id` | `inventory:read` | não |
| `PATCH` | `/api/v1/inventory/items/:id` | `inventory:update` | não |
| `GET` | `/api/v1/inventory/items` | `inventory:read` | não |
| `POST` | `/api/v1/inventory/items` | `inventory:create` | não |
| `PATCH` | `/api/v1/inventory/locations/:id` | `inventory:update` | não |
| `GET` | `/api/v1/inventory/locations` | `inventory:read` | não |
| `POST` | `/api/v1/inventory/locations` | `inventory:create` | não |
| `POST` | `/api/v1/inventory/loss-cases/:id/decide` | `inventory:approve` | não |
| `GET` | `/api/v1/inventory/loss-cases` | `inventory:read` | não |
| `POST` | `/api/v1/inventory/loss-cases` | `inventory:create` | não |
| `GET` | `/api/v1/inventory/movements` | `inventory:read` | não |
| `POST` | `/api/v1/inventory/movements` | `inventory:create` | não |
| `GET` | `/api/v1/inventory/nay/loss-case-anomalies` | `inventory:read` | não |
| `POST` | `/api/v1/inventory/nay/purchase-suggestions/:id/approve` | `procurement:create` | não |
| `POST` | `/api/v1/inventory/nay/purchase-suggestions/:id/reject` | `procurement:create` | não |
| `POST` | `/api/v1/inventory/nay/purchase-suggestions/generate` | `inventory:create` | não |
| `GET` | `/api/v1/inventory/nay/purchase-suggestions` | `inventory:read` | não |
| `POST` | `/api/v1/inventory/receipts/:id/confirm` | `inventory:create` | não |
| `POST` | `/api/v1/inventory/receipts/:id/review` | `inventory:update` | não |
| `GET` | `/api/v1/inventory/receipts/:id` | `inventory:read` | não |
| `POST` | `/api/v1/inventory/receipts/ocr-suggestions` | `inventory:create` | não |
| `GET` | `/api/v1/inventory/receipts` | `inventory:read` | não |
| `POST` | `/api/v1/inventory/receipts` | `inventory:create` | não |
| `POST` | `/api/v1/inventory/requisitions/:id/decide` | `inventory:approve` | não |
| `POST` | `/api/v1/inventory/requisitions/:id/issue` | `inventory:create` | não |
| `GET` | `/api/v1/inventory/requisitions/:id` | `inventory:read` | não |
| `GET` | `/api/v1/inventory/requisitions` | `inventory:read` | não |
| `POST` | `/api/v1/inventory/requisitions` | `inventory:create` | não |
| `GET` | `/api/v1/legal-holds/:id/impact` | `governance:legal-hold:manage` | não |
| `POST` | `/api/v1/legal-holds/:id/release` | `governance:legal-hold:manage` | sim |
| `GET` | `/api/v1/legal-holds/:id` | `governance:legal-hold:manage` | não |
| `GET` | `/api/v1/legal-holds` | `governance:legal-hold:manage` | não |
| `POST` | `/api/v1/legal-holds` | `governance:legal-hold:manage` | não |
| `POST` | `/api/v1/legal/amendments/:id/sign` | `legal:update` | não |
| `GET` | `/api/v1/legal/amendments/:id` | `legal:read` | não |
| `POST` | `/api/v1/legal/cases/:id/deadlines` | `legal:create` | não |
| `GET` | `/api/v1/legal/cases/:id/documents` | `legal:read` | não |
| `POST` | `/api/v1/legal/cases/:id/documents` | `legal:create` | não |
| `POST` | `/api/v1/legal/cases/:id/evidence-package` | `legal:create` | não |
| `POST` | `/api/v1/legal/cases/:id/evidence-packages/auto` | `legal:create` | não |
| `GET` | `/api/v1/legal/cases/:id/evidence-packages` | `legal:read` | não |
| `POST` | `/api/v1/legal/cases/:id/evidence-packages` | `legal:create` | não |
| `POST` | `/api/v1/legal/cases/:id/legal-hold` | `legal:update` | não |
| `POST` | `/api/v1/legal/cases/:id/link-task` | `legal:update` | não |
| `GET` | `/api/v1/legal/cases/:id/parties` | `legal:read` | não |
| `POST` | `/api/v1/legal/cases/:id/parties` | `legal:create` | não |
| `GET` | `/api/v1/legal/cases/:id/receivables` | `legal:read` | não |
| `POST` | `/api/v1/legal/cases/:id/receivables` | `legal:approve`, `finance:create` | não |
| `GET` | `/api/v1/legal/cases/:id/timeline` | `legal:read` | não |
| `GET` | `/api/v1/legal/cases/:id` | `legal:read` | não |
| `PATCH` | `/api/v1/legal/cases/:id` | `legal:update` | não |
| `GET` | `/api/v1/legal/cases` | `legal:read` | não |
| `POST` | `/api/v1/legal/cases` | `legal:create` | não |
| `GET` | `/api/v1/legal/clauses/:code/template-usage` | `legal:read` | não |
| `GET` | `/api/v1/legal/clauses/:code/versions` | `legal:read` | não |
| `POST` | `/api/v1/legal/clauses/:code/versions` | `legal:create` | não |
| `POST` | `/api/v1/legal/clauses/:id/approve-condition` | `legal:approve` | não |
| `POST` | `/api/v1/legal/clauses/:id/deactivate` | `legal:update` | não |
| `GET` | `/api/v1/legal/clauses` | `legal:read` | não |
| `POST` | `/api/v1/legal/clauses` | `legal:create` | não |
| `POST` | `/api/v1/legal/contract-templates/:id/clauses/:clauseId/upgrade` | `legal:create` | não |
| `POST` | `/api/v1/legal/contract-templates/:id/clauses` | `legal:create` | não |
| `POST` | `/api/v1/legal/contract-templates/:id/publish` | `legal:approve` | não |
| `POST` | `/api/v1/legal/contract-templates/:id/render` | `legal:read` | não |
| `GET` | `/api/v1/legal/contract-templates/:id/versions` | `legal:read` | não |
| `GET` | `/api/v1/legal/contract-templates/:id` | `legal:read` | não |
| `GET` | `/api/v1/legal/contract-templates` | `legal:read` | não |
| `POST` | `/api/v1/legal/contract-templates` | `legal:create` | não |
| `POST` | `/api/v1/legal/contract-versions/:id/manual-signatures` | `legal:sign` | não |
| `GET` | `/api/v1/legal/contract-versions/:id/signatures` | `legal:read` | não |
| `POST` | `/api/v1/legal/contract-versions/:id/signatures` | `legal:sign` | não |
| `POST` | `/api/v1/legal/contracts/:contractId/guarantees` | `legal:create` | não |
| `GET` | `/api/v1/legal/contracts/:id/amendments` | `legal:read` | não |
| `POST` | `/api/v1/legal/contracts/:id/amendments` | `legal:create` | não |
| `POST` | `/api/v1/legal/contracts/:id/close` | `legal:approve` | não |
| `PATCH` | `/api/v1/legal/contracts/:id/correct` | `legal:update` | sim |
| `GET` | `/api/v1/legal/contracts/:id/impact` | `legal:approve` | não |
| `POST` | `/api/v1/legal/contracts/:id/key-delivery` | `legal:create`, `lease.keys.deliver` | não |
| `GET` | `/api/v1/legal/contracts/:id/parties` | `legal:read` | não |
| `POST` | `/api/v1/legal/contracts/:id/parties` | `legal:create` | não |
| `POST` | `/api/v1/legal/contracts/:id/reactivate` | `legal:approve` | não |
| `POST` | `/api/v1/legal/contracts/:id/requirements/generate` | `legal:create` | não |
| `GET` | `/api/v1/legal/contracts/:id/requirements` | `legal:read` | não |
| `POST` | `/api/v1/legal/contracts/:id/suspend` | `legal:approve` | não |
| `POST` | `/api/v1/legal/contracts/:id/terminate` | `legal:approve` | não |
| `GET` | `/api/v1/legal/contracts/:id/timeline` | `legal:read` | não |
| `POST` | `/api/v1/legal/contracts/:id/transition` | `legal:approve` | não |
| `GET` | `/api/v1/legal/contracts/:id/versions/:versionId/generate-pdf` | `legal:read` | não |
| `GET` | `/api/v1/legal/contracts/:id/versions` | `legal:read` | não |
| `POST` | `/api/v1/legal/contracts/:id/versions` | `legal:create` | não |
| `GET` | `/api/v1/legal/contracts/:id` | `legal:read` | não |
| `GET` | `/api/v1/legal/contracts` | `legal:read` | não |
| `POST` | `/api/v1/legal/contracts` | `legal:create` | não |
| `PATCH` | `/api/v1/legal/deadlines/:id` | `legal:update` | não |
| `GET` | `/api/v1/legal/deadlines` | `legal:read` | não |
| `GET` | `/api/v1/legal/evidence-packages/:id/access-log` | `legal:read` | não |
| `GET` | `/api/v1/legal/evidence-packages/:id/export` | `legal:evidence:export` | não |
| `GET` | `/api/v1/legal/evidence-packages/:id` | `legal:read` | não |
| `GET` | `/api/v1/legal/guarantee-flows` | `legal:create` | não |
| `POST` | `/api/v1/legal/guarantees/:id/replace` | `legal:update` | não |
| `DELETE` | `/api/v1/legal/guarantees/:id` | `legal:update` | não |
| `GET` | `/api/v1/legal/guarantees/:id` | `legal:read` | não |
| `PATCH` | `/api/v1/legal/guarantees/:id` | `legal:update` | não |
| `GET` | `/api/v1/legal/guarantees` | `legal:read` | não |
| `POST` | `/api/v1/legal/inspections/:id/complete` | `legal:update` | não |
| `GET` | `/api/v1/legal/inspections/:id/items` | `legal:read` | não |
| `POST` | `/api/v1/legal/inspections/:id/items` | `legal:create` | não |
| `GET` | `/api/v1/legal/inspections/:id/report` | `legal:read` | não |
| `POST` | `/api/v1/legal/inspections/:id/report` | `legal:update` | não |
| `POST` | `/api/v1/legal/inspections/:id/revisions` | `legal:update` | não |
| `GET` | `/api/v1/legal/inspections/:id/signatures` | `legal:read` | não |
| `POST` | `/api/v1/legal/inspections/:id/sign` | `legal:update` | sim |
| `GET` | `/api/v1/legal/inspections/:id` | `legal:read` | não |
| `GET` | `/api/v1/legal/inspections/compare` | `legal:read` | não |
| `GET` | `/api/v1/legal/inspections/items/:itemId/media` | `legal:read` | não |
| `POST` | `/api/v1/legal/inspections/items/:itemId/media` | `legal:create` | não |
| `POST` | `/api/v1/legal/inspections/with-items` | `legal:create` | não |
| `GET` | `/api/v1/legal/inspections` | `legal:read` | não |
| `POST` | `/api/v1/legal/inspections` | `legal:create` | não |
| `POST` | `/api/v1/legal/key-deliveries/:id/cancel` | `lease.keys.deliver` | não |
| `POST` | `/api/v1/legal/key-deliveries/:id/release` | `lease.keys.deliver` | não |
| `GET` | `/api/v1/legal/key-deliveries/:id/term-preview` | `legal:read` | não |
| `GET` | `/api/v1/legal/key-deliveries/:id` | `legal:read` | não |
| `GET` | `/api/v1/legal/key-deliveries` | `legal:read` | não |
| `POST` | `/api/v1/legal/key-deliveries` | `legal:create` | não |
| `GET` | `/api/v1/legal/nay/cases/:id/dossier` | `legal:read` | não |
| `GET` | `/api/v1/legal/nay/cases/:id/summary` | `legal:read` | não |
| `GET` | `/api/v1/legal/nay/clause-suggestions` | `legal:read` | não |
| `GET` | `/api/v1/legal/nay/contracts/:id/compare` | `legal:read` | não |
| `GET` | `/api/v1/legal/nay/contracts/:id/summary` | `legal:read` | não |
| `POST` | `/api/v1/legal/nay/deadline-suggestions` | `legal:read` | não |
| `POST` | `/api/v1/legal/notices/:id/approve` | `legal:approve` | não |
| `POST` | `/api/v1/legal/notices/:id/delivery-evidence` | `legal:update` | não |
| `POST` | `/api/v1/legal/notices/:id/reject` | `legal:approve` | não |
| `POST` | `/api/v1/legal/notices/:id/send` | `legal:update` | sim |
| `POST` | `/api/v1/legal/notices/:id/submit-for-review` | `legal:update` | não |
| `GET` | `/api/v1/legal/notices/:id/versions` | `legal:read` | não |
| `POST` | `/api/v1/legal/notices/:id/versions` | `legal:update` | não |
| `GET` | `/api/v1/legal/notices/:id` | `legal:read` | não |
| `GET` | `/api/v1/legal/notices` | `legal:read` | não |
| `POST` | `/api/v1/legal/notices` | `legal:create` | não |
| `POST` | `/api/v1/legal/requirements/:requirementId/waive` | `legal:waive` | não |
| `PATCH` | `/api/v1/legal/requirements/:requirementId` | `legal:update` | não |
| `POST` | `/api/v1/legal/signature-envelopes/:id/switch-provider` | `legal:sign` | sim |
| `POST` | `/api/v1/legal/signatures/:externalSignatureId/webhook` | `legal:sign` | não |
| `POST` | `/api/v1/legal/signatures/:id/cancel` | `legal:sign` | não |
| `GET` | `/api/v1/legal/signatures/:id/status` | `legal:sign` | não |
| `POST` | `/api/v1/maintenance-orders/:id/close` | `inventory:update` | não |
| `PATCH` | `/api/v1/maintenance-orders/:id/schedule` | `inventory:update` | não |
| `GET` | `/api/v1/maintenance-orders` | `inventory:read` | não |
| `POST` | `/api/v1/maintenance-orders` | `inventory:create` | não |
| `GET` | `/api/v1/marketing/attribution` | `marketing:attribution:read` | não |
| `POST` | `/api/v1/marketing/automations/:id/pause` | `marketing:automation:manage` | não |
| `POST` | `/api/v1/marketing/automations/:id/publish` | `marketing:automation:publish` | não |
| `POST` | `/api/v1/marketing/automations` | `marketing:automation:manage` | não |
| `POST` | `/api/v1/marketing/campaigns/:id/deliveries/reprocess` | `marketing:campaign:manage` | não |
| `GET` | `/api/v1/marketing/campaigns/:id` | `marketing:campaign:manage` | não |
| `POST` | `/api/v1/marketing/campaigns` | `marketing:campaign:manage` | não |
| `POST` | `/api/v1/marketing/content/:id/approve` | `marketing:content:approve` | não |
| `POST` | `/api/v1/marketing/content/:id/schedule` | `marketing:content:publish` | não |
| `GET` | `/api/v1/marketing/content/:id` | `marketing:content:read` | não |
| `POST` | `/api/v1/marketing/content` | `marketing:content:write` | não |
| `POST` | `/api/v1/marketing/kill-switch/impact` | `marketing:killswitch:manage` | não |
| `POST` | `/api/v1/marketing/kill-switch` | `marketing:killswitch:manage` | não |
| `POST` | `/api/v1/marketing/media/:id/authorize` | `marketing:content:approve` | não |
| `POST` | `/api/v1/marketing/publications/:id/cancel` | `marketing:content:publish` | não |
| `GET` | `/api/v1/marketing/publications/:id/impact` | `marketing:content:publish` | não |
| `GET` | `/api/v1/marketing/publications` | `marketing:content:read` | não |
| `GET` | `/api/v1/marketing/seo/sitemap` | `marketing:content:read` | não |
| `POST` | `/api/v1/marketing/templates/:id/publish` | `marketing:template:manage` | não |
| `GET` | `/api/v1/marketing/templates` | `marketing:content:read` | não |
| `POST` | `/api/v1/marketing/templates` | `marketing:template:manage` | não |
| `POST` | `/api/v1/marketing/tracking-links` | `marketing:campaign:manage` | não |
| `DELETE` | `/api/v1/memberships/:id` | `memberships:delete` | sim |
| `GET` | `/api/v1/memberships/:userId/effective-permissions` | `memberships:read` | não |
| `GET` | `/api/v1/memberships` | `memberships:read` | não |
| `POST` | `/api/v1/memberships` | `memberships:create` | sim |
| `POST` | `/api/v1/messages/:id/refresh-status` | `crm:messages:update` | não |
| `POST` | `/api/v1/messages/:id/send-alternate` | `crm:messages:create` | não |
| `PATCH` | `/api/v1/messages/:id/status` | `crm:messages:update` | não |
| `GET` | `/api/v1/messages/:id` | `crm:messages:read` | não |
| `POST` | `/api/v1/messages/send` | `crm:messages:create` | não |
| `GET` | `/api/v1/messages` | `crm:messages:read` | não |
| `POST` | `/api/v1/messages` | `crm:messages:create` | não |
| `POST` | `/api/v1/migration/batches/:id/replay` | `governance:migration:run` | não |
| `POST` | `/api/v1/migration/canary/:sector/advance` | `governance:migration:run`, `governance:flags:manage` | não |
| `GET` | `/api/v1/migration/canary/:sector/impact` | `governance:migration:run`, `governance:flags:manage` | não |
| `POST` | `/api/v1/migration/canary/:sector/rollback` | `governance:migration:run`, `governance:flags:manage` | sim |
| `GET` | `/api/v1/migration/canary` | `governance:migration:run` | não |
| `GET` | `/api/v1/migration/control-tower` | `governance:migration:run` | não |
| `POST` | `/api/v1/migration/cutover/decision` | `governance:migration:admin` | não |
| `GET` | `/api/v1/migration/dry-runs/:id/report` | `governance:migration:run` | não |
| `POST` | `/api/v1/migration/dry-runs` | `governance:migration:run` | não |
| `GET` | `/api/v1/migration/external-ops` | `governance:migration:admin` | não |
| `PUT` | `/api/v1/migration/external-ops` | `governance:migration:admin` | não |
| `GET` | `/api/v1/migration/parallel/windows/:id` | `governance:migration:run` | não |
| `POST` | `/api/v1/migration/parallel/windows` | `governance:migration:run` | não |
| `GET` | `/api/v1/migration/raci` | `governance:migration:run` | não |
| `PUT` | `/api/v1/migration/raci` | `governance:migration:admin` | não |
| `POST` | `/api/v1/migration/records/:id/resolve` | `governance:migration:run` | não |
| `POST` | `/api/v1/migration/rollback-items/:id/resolve` | `governance:migration:admin` | não |
| `GET` | `/api/v1/migration/rollback-report` | `governance:migration:admin` | não |
| `POST` | `/api/v1/migration/runs` | `governance:migration:run` | não |
| `POST` | `/api/v1/offers/:id/publish` | `properties:update` | não |
| `GET` | `/api/v1/opportunities/:id/carts` | `crm:opportunities:read` | não |
| `POST` | `/api/v1/opportunities/:id/carts` | `crm:opportunities:update` | não |
| `GET` | `/api/v1/opportunities/:id/tasks` | `crm:tasks:read` | não |
| `POST` | `/api/v1/opportunities/:id/tasks` | `crm:tasks:create` | não |
| `GET` | `/api/v1/opportunities/:id/timeline` | `crm:opportunities:read` | não |
| `DELETE` | `/api/v1/opportunities/:id` | `crm:opportunities:delete` | não |
| `GET` | `/api/v1/opportunities/:id` | `crm:opportunities:read` | não |
| `PATCH` | `/api/v1/opportunities/:id` | `crm:opportunities:update` | não |
| `GET` | `/api/v1/opportunities` | `crm:opportunities:read` | não |
| `POST` | `/api/v1/opportunities` | `crm:opportunities:create` | não |
| `PUT` | `/api/v1/parameters/commission` | `correspondent:parameters` | não |
| `PUT` | `/api/v1/parameters/eligibility` | `correspondent:parameters` | não |
| `GET` | `/api/v1/parameters` | `correspondent:read` | não |
| `GET` | `/api/v1/people/:id/addresses` | `people:read` | não |
| `POST` | `/api/v1/people/:id/addresses` | `people:update` | não |
| `GET` | `/api/v1/people/:id/consents` | `people:read` | não |
| `POST` | `/api/v1/people/:id/consents` | `people:update` | não |
| `DELETE` | `/api/v1/people/:id/contacts/:contactId` | `people:update` | não |
| `PATCH` | `/api/v1/people/:id/contacts/:contactId` | `people:update` | não |
| `GET` | `/api/v1/people/:id/contacts` | `people:read` | não |
| `POST` | `/api/v1/people/:id/contacts` | `people:update` | não |
| `DELETE` | `/api/v1/people/:id/documents/:documentId` | `people:update` | não |
| `PATCH` | `/api/v1/people/:id/documents/:documentId` | `people:update` | não |
| `POST` | `/api/v1/people/:id/documents/ingest` | `people:update` | não |
| `GET` | `/api/v1/people/:id/documents` | `people:read` | não |
| `POST` | `/api/v1/people/:id/documents` | `people:update` | não |
| `POST` | `/api/v1/people/:id/merge` | `people:update` | não |
| `DELETE` | `/api/v1/people/:id/roles/:roleId` | `people:update` | não |
| `PATCH` | `/api/v1/people/:id/roles/:roleId` | `people:update` | não |
| `GET` | `/api/v1/people/:id/roles` | `people:read` | não |
| `POST` | `/api/v1/people/:id/roles` | `people:update` | não |
| `POST` | `/api/v1/people/:id/unlink` | `people:link` | não |
| `DELETE` | `/api/v1/people/:id` | `people:delete` | não |
| `GET` | `/api/v1/people/:id` | `people:read` | não |
| `PATCH` | `/api/v1/people/:id` | `people:update` | não |
| `POST` | `/api/v1/people/duplicates/check` | `people:create` | não |
| `GET` | `/api/v1/people/duplicates` | `people:read` | não |
| `POST` | `/api/v1/people/links` | `people:link` | não |
| `GET` | `/api/v1/people/roles-catalog` | `people:read` | não |
| `GET` | `/api/v1/people` | `people:read` | não |
| `POST` | `/api/v1/people` | `people:create` | não |
| `GET` | `/api/v1/permissions` | `roles:read` | não |
| `GET` | `/api/v1/procurement/approval-threshold-rule` | `procurement:read` | não |
| `POST` | `/api/v1/procurement/approval-threshold-rule` | `procurement:approve` | não |
| `POST` | `/api/v1/procurement/discrepancies/:id/resolve` | `procurement:approve` | não |
| `GET` | `/api/v1/procurement/discrepancies` | `procurement:read` | não |
| `POST` | `/api/v1/procurement/insurance-claims/:id/submit` | `procurement:approve` | não |
| `POST` | `/api/v1/procurement/insurance-installments/:installmentId/pay` | `procurement:approve` | não |
| `POST` | `/api/v1/procurement/insurance-policies/:id/cancel` | `procurement:approve` | não |
| `POST` | `/api/v1/procurement/insurance-policies/:id/claims` | `procurement:create` | não |
| `GET` | `/api/v1/procurement/insurance-policies/:id/documents` | `procurement:read` | não |
| `POST` | `/api/v1/procurement/insurance-policies/:id/documents` | `procurement:create` | não |
| `GET` | `/api/v1/procurement/insurance-policies/:id/installments` | `procurement:read` | não |
| `POST` | `/api/v1/procurement/insurance-policies/:id/issue` | `procurement:approve` | não |
| `POST` | `/api/v1/procurement/insurance-policies/:id/quote` | `procurement:create` | não |
| `GET` | `/api/v1/procurement/insurance-policies/:id/versions` | `procurement:read` | não |
| `POST` | `/api/v1/procurement/insurance-policies/:id/versions` | `procurement:approve` | não |
| `GET` | `/api/v1/procurement/insurance-policies/:id` | `procurement:read` | não |
| `GET` | `/api/v1/procurement/insurance-policies` | `procurement:read` | não |
| `POST` | `/api/v1/procurement/insurance-policies` | `procurement:create` | não |
| `POST` | `/api/v1/procurement/insurance-renewal-tasks/:id/complete` | `procurement:approve` | não |
| `POST` | `/api/v1/procurement/insurance-tasks/:id/cancel` | `procurement:approve` | não |
| `POST` | `/api/v1/procurement/insurance-tasks/:id/complete` | `procurement:approve` | não |
| `GET` | `/api/v1/procurement/insurance-tasks` | `procurement:read` | não |
| `POST` | `/api/v1/procurement/offers/:id/award` | `procurement:approve` | não |
| `POST` | `/api/v1/procurement/purchase-orders/:id/cancel` | `procurement:approve` | não |
| `GET` | `/api/v1/procurement/purchase-orders/:id/goods-receipts` | `procurement:read` | não |
| `POST` | `/api/v1/procurement/purchase-orders/:id/goods-receipts` | `procurement:create` | não |
| `GET` | `/api/v1/procurement/purchase-orders/:id/impact` | `procurement:approve` | não |
| `GET` | `/api/v1/procurement/purchase-orders/:id` | `procurement:read` | não |
| `GET` | `/api/v1/procurement/purchase-orders` | `procurement:read` | não |
| `POST` | `/api/v1/procurement/purchase-requests/:id/decide` | `procurement:approve` | não |
| `POST` | `/api/v1/procurement/purchase-requests/:id/quotations` | `procurement:create` | não |
| `GET` | `/api/v1/procurement/purchase-requests/:id` | `procurement:read` | não |
| `GET` | `/api/v1/procurement/purchase-requests` | `procurement:read` | não |
| `POST` | `/api/v1/procurement/purchase-requests` | `procurement:create` | não |
| `GET` | `/api/v1/procurement/quotations/:id/compare` | `procurement:read` | não |
| `POST` | `/api/v1/procurement/quotations/:id/offers` | `procurement:create` | não |
| `GET` | `/api/v1/procurement/supplier-evaluations` | `procurement:read` | não |
| `POST` | `/api/v1/procurement/supplier-evaluations` | `procurement:create` | não |
| `POST` | `/api/v1/procurement/supplier-qualifications/:id/decide` | `procurement:approve` | não |
| `GET` | `/api/v1/procurement/supplier-qualifications` | `procurement:read` | não |
| `POST` | `/api/v1/procurement/supplier-qualifications` | `procurement:create` | não |
| `DELETE` | `/api/v1/properties/:id/documents/:documentId` | `properties:update` | não |
| `GET` | `/api/v1/properties/:id/documents` | `properties:read` | não |
| `POST` | `/api/v1/properties/:id/documents` | `properties:update` | não |
| `GET` | `/api/v1/properties/:id/impact` | `properties:delete` | não |
| `PATCH` | `/api/v1/properties/:id/media/:mediaId/quality` | `properties:update` | não |
| `DELETE` | `/api/v1/properties/:id/media/:mediaId` | `properties:update` | não |
| `GET` | `/api/v1/properties/:id/media` | `properties:read` | não |
| `POST` | `/api/v1/properties/:id/media` | `properties:update` | não |
| `GET` | `/api/v1/properties/:id/occurrences` | `properties:internal` | não |
| `POST` | `/api/v1/properties/:id/occurrences` | `properties:internal` | não |
| `PATCH` | `/api/v1/properties/:id/offers/:offerId` | `properties:update` | não |
| `GET` | `/api/v1/properties/:id/offers` | `properties:read` | não |
| `POST` | `/api/v1/properties/:id/offers` | `properties:update` | não |
| `DELETE` | `/api/v1/properties/:id/owners/:ownerId` | `properties:update` | não |
| `PATCH` | `/api/v1/properties/:id/owners/:ownerId` | `properties:update` | não |
| `GET` | `/api/v1/properties/:id/owners` | `properties:read` | não |
| `POST` | `/api/v1/properties/:id/owners` | `properties:update` | não |
| `POST` | `/api/v1/properties/:id/portal-listings/publish` | `properties:update` | não |
| `POST` | `/api/v1/properties/:id/portal-listings/unpublish` | `properties:update` | não |
| `GET` | `/api/v1/properties/:id/portal-listings` | `properties:read` | não |
| `GET` | `/api/v1/properties/:id/price-history` | `properties:read` | não |
| `DELETE` | `/api/v1/properties/:id` | `properties:delete` | não |
| `GET` | `/api/v1/properties/:id` | `properties:read` | não |
| `PATCH` | `/api/v1/properties/:id` | `properties:update` | não |
| `GET` | `/api/v1/properties` | `properties:read` | não |
| `POST` | `/api/v1/properties` | `properties:create` | não |
| `PATCH` | `/api/v1/provider-accounts/:id` | `correspondent:parameters` | não |
| `GET` | `/api/v1/provider-accounts` | `correspondent:parameters` | não |
| `POST` | `/api/v1/provider-accounts` | `correspondent:parameters` | não |
| `GET` | `/api/v1/radar/:id/match-history` | `radar:read` | não |
| `GET` | `/api/v1/radar/:id/matches/:propertyId/explain` | `radar:read` | não |
| `GET` | `/api/v1/radar/:id/matches` | `radar:read` | não |
| `DELETE` | `/api/v1/radar/:id` | `radar:delete` | não |
| `GET` | `/api/v1/radar/:id` | `radar:read` | não |
| `PATCH` | `/api/v1/radar/:id` | `radar:update` | não |
| `GET` | `/api/v1/radar` | `radar:read` | não |
| `POST` | `/api/v1/radar` | `radar:create` | não |
| `POST` | `/api/v1/retention/dry-run` | `governance:retention:manage` | não |
| `GET` | `/api/v1/retention/policies` | `governance:retention:manage` | não |
| `PUT` | `/api/v1/retention/policies` | `governance:retention:manage` | não |
| `POST` | `/api/v1/retention/runs/:id/apply` | `governance:retention:manage` | sim |
| `GET` | `/api/v1/retention/runs/:id/impact` | `governance:retention:manage` | não |
| `GET` | `/api/v1/retention/runs/:id` | `governance:retention:manage` | não |
| `GET` | `/api/v1/retention/runs` | `governance:retention:manage` | não |
| `DELETE` | `/api/v1/roles/:id` | `roles:delete` | sim |
| `GET` | `/api/v1/roles/:id` | `roles:read` | não |
| `PATCH` | `/api/v1/roles/:id` | `roles:update` | sim |
| `GET` | `/api/v1/roles` | `roles:read` | não |
| `POST` | `/api/v1/roles` | `roles:create` | sim |
| `GET` | `/api/v1/settings/:key` | `settings:read` | não |
| `PUT` | `/api/v1/settings/:key` | `settings:update` | não |
| `GET` | `/api/v1/settings/integrations/status` | `settings:read` | não |
| `GET` | `/api/v1/settings` | `settings:read` | não |
| `PATCH` | `/api/v1/tasks/:id` | `crm:tasks:create` | não |
| `POST` | `/api/v1/tool-loans/:id/return` | `inventory:update` | não |
| `GET` | `/api/v1/tool-loans` | `inventory:read` | não |
| `DELETE` | `/api/v1/units/:id` | `units:delete` | não |
| `GET` | `/api/v1/units/:id` | `units:read` | não |
| `PATCH` | `/api/v1/units/:id` | `units:update` | não |
| `GET` | `/api/v1/units` | `units:read` | não |
| `POST` | `/api/v1/units` | `units:create` | não |
| `PATCH` | `/api/v1/users/:id/deactivate` | `users:update` | sim |
| `GET` | `/api/v1/users/:id/impact` | `users:update` | não |
| `PATCH` | `/api/v1/users/:id/set-password` | `users:update` | sim |
| `DELETE` | `/api/v1/users/:id` | `users:delete` | não |
| `GET` | `/api/v1/users/:id` | `users:read` | não |
| `PATCH` | `/api/v1/users/:id` | `users:update` | não |
| `GET` | `/api/v1/users` | `users:read` | não |
| `POST` | `/api/v1/users` | `users:create` | não |
| `DELETE` | `/api/v1/visits/:id` | `crm:visits:delete` | não |
| `GET` | `/api/v1/visits/:id` | `crm:visits:read` | não |
| `PATCH` | `/api/v1/visits/:id` | `crm:visits:update` | não |
| `GET` | `/api/v1/visits` | `crm:visits:read` | não |
| `POST` | `/api/v1/visits` | `crm:visits:create` | não |

## Catálogo de permissões de governança (governance:*)

Catálogo fechado do Marco 9 (M9-D800). Permissão sem rota nesta tabela ainda não foi ligada por uma demanda do bloco.

| Permissão | Risco | Rotas que a exigem |
|---|---|---|
| `governance:calendar:read` | LOW | `GET /api/v1/calendar/commitments/:id`, `PATCH /api/v1/calendar/commitments/:id`, `POST /api/v1/calendar/commitments`, `DELETE /api/v1/calendar/items/:id`, `PATCH /api/v1/calendar/items/:id`, `PUT /api/v1/calendar/items/:id`, `GET /api/v1/calendar` |
| `governance:data-quality:read` | LOW | `GET /api/v1/data-classification/legacy-review`, `GET /api/v1/data-classification`, `GET /api/v1/data-quality/domains`, `GET /api/v1/data-quality/queue/:id/impact`, `GET /api/v1/data-quality/queue`, `GET /api/v1/data-quality` |
| `governance:data-quality:manage` | MEDIUM | `PUT /api/v1/data-quality/domains/:code/assignments`, `POST /api/v1/data-quality/queue/:id/decision` |
| `governance:data-quality:bulk` | CRITICAL | `GET /api/v1/data-quality/bulk-changes/:id`, `POST /api/v1/data-quality/bulk-changes/impact`, `GET /api/v1/data-quality/bulk-changes`, `POST /api/v1/data-quality/bulk-changes` |
| `governance:lineage:manage` | HIGH | `POST /api/v1/data-lineage/edges`, `PUT /api/v1/data-lineage/edges`, `POST /api/v1/data-lineage/nodes`, `PUT /api/v1/data-lineage/nodes`, `GET /api/v1/data-lineage` |
| `governance:dlp:export` | MEDIUM | `GET /api/v1/dlp/policies`, `GET /api/v1/dlp/share-links/:id/impact`, `POST /api/v1/dlp/share-links/:id/revoke`, `GET /api/v1/dlp/share-links`, `POST /api/v1/dlp/share-links`, `GET /api/v1/exports/:id/download`, `GET /api/v1/exports/:id`, `GET /api/v1/exports/catalog`, `POST /api/v1/exports` |
| `governance:dlp:admin` | CRITICAL | `POST /api/v1/dlp/anomalies/:id/review`, `GET /api/v1/dlp/anomalies`, `PUT /api/v1/dlp/policies/:classification/:action`, `GET /api/v1/dlp` |
| `governance:dlp:view-restricted` | CRITICAL | nenhuma ainda |
| `governance:bcp:record` | MEDIUM | `GET /api/v1/bcp/form-templates/:sector/:formType/print`, `GET /api/v1/bcp/form-templates`, `PATCH /api/v1/bcp/manual-operations/:id`, `GET /api/v1/bcp/manual-operations`, `POST /api/v1/bcp/manual-operations`, `GET /api/v1/bcp` |
| `governance:bcp:import` | HIGH | `POST /api/v1/bcp/manual-operations/import`, `GET /api/v1/bcp/reconciliations` |
| `governance:bcp:approve` | CRITICAL | `POST /api/v1/bcp/reconciliations/:id/decide` |
| `governance:api:read` | LOW | `GET /api/v1/api-governance/clients`, `GET /api/v1/api-governance/consumers`, `GET /api/v1/api-governance/deprecations` |
| `governance:api:manage` | HIGH | `GET /api/v1/api-governance/clients/:id/impact`, `POST /api/v1/api-governance/clients/:id/revoke`, `POST /api/v1/api-governance/clients/impact`, `POST /api/v1/api-governance/clients`, `POST /api/v1/api-governance/deprecations/:id/cancel`, `POST /api/v1/api-governance/deprecations` |
| `governance:finops:read` | LOW | `GET /api/v1/finops/budgets`, `GET /api/v1/finops/degradation-policies`, `GET /api/v1/finops/health` |
| `governance:finops:manage` | HIGH | `PATCH /api/v1/finops/budgets/:id`, `POST /api/v1/finops/budgets`, `PUT /api/v1/finops/degradation-policies` |
| `governance:flags:manage` | CRITICAL | `POST /api/v1/feature-flags/impact`, `GET /api/v1/feature-flags`, `PATCH /api/v1/feature-flags`, `POST /api/v1/feature-flags`, `POST /api/v1/migration/canary/:sector/advance`, `GET /api/v1/migration/canary/:sector/impact`, `POST /api/v1/migration/canary/:sector/rollback` |
| `governance:migration:run` | CRITICAL | `POST /api/v1/migration/batches/:id/replay`, `POST /api/v1/migration/canary/:sector/advance`, `GET /api/v1/migration/canary/:sector/impact`, `POST /api/v1/migration/canary/:sector/rollback`, `GET /api/v1/migration/canary`, `GET /api/v1/migration/control-tower`, `GET /api/v1/migration/dry-runs/:id/report`, `POST /api/v1/migration/dry-runs`, `GET /api/v1/migration/parallel/windows/:id`, `POST /api/v1/migration/parallel/windows`, `GET /api/v1/migration/raci`, `POST /api/v1/migration/records/:id/resolve`, `POST /api/v1/migration/runs` |
| `governance:migration:admin` | CRITICAL | `POST /api/v1/migration/cutover/decision`, `GET /api/v1/migration/external-ops`, `PUT /api/v1/migration/external-ops`, `PUT /api/v1/migration/raci`, `POST /api/v1/migration/rollback-items/:id/resolve`, `GET /api/v1/migration/rollback-report` |
| `governance:classification:manage` | HIGH | `PUT /api/v1/ai/files/:fileId/classification`, `PUT /api/v1/data-classification`, `PUT /api/v1/files/:id/classification` |
| `governance:retention:manage` | HIGH | `POST /api/v1/retention/dry-run`, `GET /api/v1/retention/policies`, `PUT /api/v1/retention/policies`, `POST /api/v1/retention/runs/:id/apply`, `GET /api/v1/retention/runs/:id/impact`, `GET /api/v1/retention/runs/:id`, `GET /api/v1/retention/runs` |
| `governance:legal-hold:manage` | CRITICAL | `GET /api/v1/legal-holds/:id/impact`, `POST /api/v1/legal-holds/:id/release`, `GET /api/v1/legal-holds/:id`, `GET /api/v1/legal-holds`, `POST /api/v1/legal-holds` |

## Rotas só com login ou públicas

| Método | Caminho | Permissão exigida | MFA recente |
|---|---|---|---|
| `GET` | `/api/health/pool` | público (saúde do serviço) | não |
| `GET` | `/api/health` | público (saúde do serviço) | não |
| `POST` | `/api/marketing/unsubscribe` | público; autenticidade pelo token assinado do link de descadastro | não |
| `POST` | `/api/marketing/webhooks/:channel` | público; autenticidade pela assinatura do provider | não |
| `GET` | `/api/public/properties/:publicId` | público; página do imóvel no site (M9-D427), só dado publicável | não |
| `GET` | `/api/t/:shortCode` | só login | não |
| `GET` | `/api/v1/api-external/contracts` | token de cliente com o scope `contracts:read` | não |
| `POST` | `/api/v1/api-external/leads` | token de cliente com o scope `leads:write` | não |
| `POST` | `/api/v1/api-external/oauth/token` | público (troca client id e segredo por token de cliente) | não |
| `GET` | `/api/v1/api-external/properties` | token de cliente com o scope `properties:read` | não |
| `GET` | `/api/v1/auth/companies` | só login | não |
| `POST` | `/api/v1/auth/login` | público (obtém ou renova o token) | não |
| `POST` | `/api/v1/auth/logout` | só login | não |
| `POST` | `/api/v1/auth/refresh` | público (obtém ou renova o token) | não |
| `POST` | `/api/v1/auth/switch-company` | só login | não |
| `POST` | `/api/v1/correspondent/webhooks/financing/:provider` | público; autenticidade pela assinatura do provider | não |
| `POST` | `/api/v1/crm/carts/public/:token/properties/:propertyId/click` | público; acesso pelo token do link | não |
| `GET` | `/api/v1/crm/carts/public/:token` | público; acesso pelo token do link | não |
| `POST` | `/api/v1/dlp/copy-events` | só login | não |
| `GET` | `/api/v1/dlp/print-events/:id/pdf` | só login | não |
| `POST` | `/api/v1/dlp/print-events` | só login | não |
| `GET` | `/api/v1/files/:id/content` | só login; o acesso ao arquivo é decidido pelo dono e pela permissão do módulo | não |
| `GET` | `/api/v1/files/:id/download` | só login; o acesso ao arquivo é decidido pelo dono e pela permissão do módulo | não |
| `GET` | `/api/v1/files/:id` | só login; o acesso ao arquivo é decidido pelo dono e pela permissão do módulo | não |
| `POST` | `/api/v1/files/download-batch` | só login; o acesso ao arquivo é decidido pelo dono e pela permissão do módulo | não |
| `GET` | `/api/v1/files/downloads/:jobId` | só login; o acesso ao arquivo é decidido pelo dono e pela permissão do módulo | não |
| `POST` | `/api/v1/files` | só login; o acesso ao arquivo é decidido pelo dono e pela permissão do módulo | não |
| `POST` | `/api/v1/finance/webhooks/bank-payment` | público; autenticidade pela assinatura do provider | não |
| `GET` | `/api/v1/health/db` | público (saúde do serviço) | não |
| `POST` | `/api/v1/legal/webhooks/clicksign` | público; autenticidade pela assinatura do provider | não |
| `POST` | `/api/v1/marketing/unsubscribe` | público; autenticidade pelo token assinado do link de descadastro | não |
| `POST` | `/api/v1/marketing/webhooks/:channel` | público; autenticidade pela assinatura do provider | não |
| `GET` | `/api/v1/ping` | público (saúde do serviço) | não |
| `POST` | `/api/v1/procurement/webhooks/insurance` | público; autenticidade pela assinatura do provider | não |
| `GET` | `/api/v1/public/properties/:publicId` | público; página do imóvel no site (M9-D427), só dado publicável | não |
| `GET` | `/api/v1/public/share/:token` | só login | não |
| `POST` | `/api/v1/users/me/mfa/confirm` | só login (o próprio usuário) | não |
| `POST` | `/api/v1/users/me/mfa/disable` | só login (o próprio usuário) | não |
| `POST` | `/api/v1/users/me/mfa/setup` | só login (o próprio usuário) | não |
| `POST` | `/api/v1/users/me/mfa/verify` | só login (o próprio usuário) | não |
| `POST` | `/api/v1/webhooks/:provider/:channel` | público; autenticidade pela assinatura do provider | não |
| `POST` | `/api/v1/webhooks/signature/:provider` | público; autenticidade pela assinatura do provider | não |
| `GET` | `/api/version` | público (saúde do serviço) | não |
| `POST` | `/api/webhooks/:provider/:channel` | público; autenticidade pela assinatura do provider | não |
