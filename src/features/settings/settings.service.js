'use strict';

const { Op } = require('sequelize');
const { TenantSetting } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { encryptSecret, decryptSecret } = require('../../utils/mfaCrypto');
const { GOVERNANCE_SETTINGS_SCHEMA } = require('../../features/core-governance/governance.settings');
const { PEOPLE_LINK_SETTINGS_SCHEMA } = require('../people/personLink.settings');
const { PEOPLE_M3PE_SETTINGS_SCHEMA } = require('../people/people.settings');
const { runSettingGuard } = require('./settingGuards');
const { isPlatformOnly } = require('./settingPlatform');
const { assertMfaForSettingWrite } = require('./settingMfa');
require('./ambienteBi.guard'); // M9-D708: trava de PRODUCAO do ambiente do BI (aceite dos owners)
require('./legadoEmpresa.guard'); // M9-D900: o código da empresa no sistema antigo é único no grupo
require('../marketing/mass.settingGuard'); // M9-D402: o teto absoluto de destinatários nunca fica abaixo do limite sem aprovação
const { AI_SETTINGS_SCHEMA } = require('../../features/ai/ai.settings');
const { MARKETING_SETTINGS_SCHEMA } = require('../../features/marketing/marketing.settings');
const { parseBackoffList } = require('../../engines/events/outboxBackoffParse');
const { PUBLIC_FIELDS_SETTINGS_SCHEMA } = require('../../features/marketing/content/publicFields.settings');
const { TEMPLATE_SETTINGS_SCHEMA } = require('../../features/marketing/content/template.settings');
const { TRACKING_SETTINGS_SCHEMA } = require('../../features/marketing/tracking/tracking.settings');
const { PIPELINE_SETTINGS_SCHEMA } = require('../../features/marketing/content/pipeline.settings');
const { SCHEDULE_SETTINGS_SCHEMA } = require('../../features/marketing/publications/schedule/schedule.settings');
const { WORKER_SETTINGS_SCHEMA } = require('../../features/marketing/publications/worker/worker.settings');
const { DRILL_SETTINGS_SCHEMA } = require('../../features/marketing/publications/drill/drill.settings');
const { LEAD_PARAMS_SCHEMA } = require('../../features/marketing/automations/leadParams');
const { AUTOPUBLISH_SETTINGS_SCHEMA } = require('../../features/marketing/content/autopublish.settings');
const { RUNNER_SETTINGS_SCHEMA } = require('../../features/marketing/automations/runner/runner.settings');
const { URL_SETTINGS_SCHEMA } = require('../../features/marketing/security/url.settings');
const { URL_LIMITS_SCHEMA } = require('../../features/marketing/security/urlText.limits');
const { TYPES_SETTINGS_SCHEMA } = require('../../features/marketing/content/types/types.settings');
const { FACTUAL_SETTINGS_SCHEMA } = require('../../features/marketing/content/factual/settings');
const { CAMPAIGN_SETTINGS_SCHEMA } = require('../../features/marketing/campaigns/campaigns.settings');
const { COST_SETTINGS_SCHEMA } = require('../../features/marketing/campaigns/cost.settings');
const { SEGMENT_SETTINGS_SCHEMA } = require('../../features/marketing/campaigns/segment.settings');
const { CADENCE_SETTINGS_SCHEMA } = require('../../features/marketing/automations/cadence/cadence.settings');
const { SEEDS_SETTINGS_SCHEMA } = require('../../features/marketing/automations/seeds/seeds.settings');
const { CHANNEL_SETTINGS_SCHEMA } = require('../../features/marketing/publications/adapters/channel.settings');
const { SUPPRESSION_SETTINGS_SCHEMA } = require('../../features/marketing/suppression/suppression.settings');
const { SEO_SETTINGS_SCHEMA } = require('../../features/marketing/publications/seo/seo.settings');
const { BLOG_SETTINGS_SCHEMA } = require('../../features/marketing/content/blog/blog.settings');
const { PREVIEW_SETTINGS_SCHEMA } = require('../../features/marketing/publications/messaging/preview/preview.settings');
const { KILLSWITCH_SETTINGS_SCHEMA } = require('../../features/marketing/killswitch.settings');
const { VIDEO_SETTINGS_SCHEMA } = require('../../features/marketing/content/video/video.settings');
const { SOCIAL_SETTINGS_SCHEMA } = require('../../features/marketing/publications/adapters/social/social.settings');
const { CATALOG_SETTINGS_SCHEMA, IntegrationHttpClient } = require('../integrations');
const { SECRET_SETTINGS_SCHEMA } = require('../integrations/secrets/secrets.settings');
const { HEALTH_SETTINGS_SCHEMA } = require('../integrations/health/health.settings');
const { CIRCUIT_SETTINGS_SCHEMA } = require('../integrations/health/circuit.settings');
const { ALERT_SETTINGS_SCHEMA } = require('../integrations/health/alerts/alerts.settings');
const { ERRORS_SETTINGS_SCHEMA } = require('../integrations/errors/errors.settings');
const { SYNC_SETTINGS_SCHEMA } = require('../integrations/sync/sync.settings');
const { INBOX_SETTINGS_SCHEMA } = require('../integrations/inbox/inbox.settings');
const { WEBHOOK_SETTINGS_SCHEMA } = require('../integrations/webhooks/webhooks.settings');
const { SIGNATURE_SETTINGS_SCHEMA } = require('../../modules/legal/signatures/framework/signature.settings');
const { DISPATCH_SETTINGS_SCHEMA } = require('../integrations/dispatch/dispatch.settings');
const { INSURANCE_SETTINGS_SCHEMA } = require('../procurement/insurance/insurance.settings');
const { NFSE_SETTINGS_SCHEMA } = require('../correspondent/fiscal/nfse/nfse.settings');
const { CONTINGENCY_SETTINGS_SCHEMA } = require('../integrations/contingency/contingency.settings');
const { BANK_SETTINGS_SCHEMA } = require('../../modules/finance/infrastructure/bank/hub/bank.settings');
const { FINANCE_SETTINGS_SCHEMA } = require('../../modules/finance/application/services/finance-settings');
const { PORTAL_SETTINGS_SCHEMA } = require('../integrations/portal/portal.settings');
const { STORAGE_SETTINGS_SCHEMA } = require('../integrations/storage/storage.settings');
const { IDENTITY_SETTINGS_SCHEMA } = require('../integrations/identity/identity.settings');
const { SITE_SETTINGS_SCHEMA } = require('../integrations/site/site.settings');
const { QUARANTINE_SETTINGS_SCHEMA } = require('../files/quarantine/quarantine.settings');
const { ACTIONS_SETTINGS_SCHEMA } = require('../integrations/admin/actions/actions.settings');
const { MINIMIZATION_SETTINGS_SCHEMA } = require('../integrations/minimization/minimization.settings');
const { PUBLICATION_SETTINGS_SCHEMA } = require('../properties/publicReadModel/publicReadModel.settings');
const { PROPERTY_PUBLICATION_SETTINGS_SCHEMA } = require('../properties/propertyPublication.settings');
const { CART_SETTINGS_SCHEMA } = require('../crm/carts.settings');
const { ADAPTERS_SETTINGS_SCHEMA } = require('../integrations/registry/adapters.settings');
const { MESSAGING_SETTINGS_SCHEMA } = require('../crm/messaging/messaging.settings');
const { CARTEIRA_SETTINGS_SCHEMA } = require('../crm/carteira/carteira.settings');
const { CRM_EXPORT_SETTINGS_SCHEMA } = require('../crm/opportunitiesExport.settings');
const { CRM_SETTINGS_SCHEMA } = require('../crm/crm.settings'); // DI-M3CA: motivos, SLA da ocorrência e escalonamento do CRM
require('../crm/crm.settingGuards');
const { CONTRACT_SETTINGS_SCHEMA } = require('../integrations/contract/contract.settings');
const { DOMAIN_SETTINGS_SCHEMA } = require('../integrations/domain/domain.settings');
const { DEPAUDIT_SETTINGS_SCHEMA } = require('../integrations/depaudit/depaudit.settings');
const { TRANSPORT_SETTINGS_SCHEMA } = require('../integrations/http/transport.settings');
const { RETENTION_SETTINGS_SCHEMA } = require('../integrations/retention/retention.settings');
const { LOAD_INTEGRATION_SETTINGS_SCHEMA } = require('../integrations/load/load.settings');
const { RELEASE_SETTINGS_SCHEMA } = require('../integrations/registry/release.settings');
const { READ_ONLY_SETTINGS_SCHEMA } = require('../../features/analytics/readOnly/readOnly.settings');
const { SECURITY_SETTINGS_SCHEMA } = require('../../features/analytics/security/security.settings');
const { METRICS_SETTINGS_SCHEMA } = require('../../features/analytics/metrics/metrics.settings');
const { READ_MODEL_SETTINGS_SCHEMA } = require('../../features/analytics/read-models/readModel.settings');
const { REBUILD_SETTINGS_SCHEMA } = require('../../features/analytics/read-models/rebuild.settings');
const { SOURCE_REFS_SETTINGS_SCHEMA } = require('../../features/analytics/metrics/sourceRefs.settings');
const { DRILLDOWN_SETTINGS_SCHEMA } = require('../../features/analytics/metrics/drilldown.settings');
const { FINANCE_HEALTH_SETTINGS_SCHEMA } = require('../../features/analytics/read-models/financeHealth.settings');
const { FINANCE_KPI_SETTINGS_SCHEMA } = require('../analytics/read-models/financeKpi.settings');
const { CASH_SETTINGS_SCHEMA } = require('../analytics/read-models/cash.settings');
const { FINANCE_WINDOW_SETTINGS_SCHEMA } = require('../analytics/read-models/financeWindow.settings');
const { CRM_KPI_SETTINGS_SCHEMA } = require('../analytics/read-models/crmKpi.settings');
const { FINANCE_RESULT_SETTINGS_SCHEMA } = require('../analytics/read-models/financeResults.settings');
const { FINANCE_DELINQUENCY_SETTINGS_SCHEMA } = require('../analytics/read-models/financeDelinquency.settings');
const { PANEL_SETTINGS_SCHEMA } = require('../analytics/panelSettings'); // M9-D626
const { LOAD_SETTINGS_SCHEMA } = require('../analytics/loadTest.settings');
const { QUERY_SETTINGS_SCHEMA } = require('../analytics/metrics/query.settings');
const { DECISAO_FILA_SETTINGS_SCHEMA } = require('../analytics/read-models/decisaoFilaKpi.settings');
const { TECH_SETTINGS_SCHEMA } = require('../../features/analytics/read-models/tecnologia.settings');
const { TECH_KPI_SETTINGS_SCHEMA } = require('../../features/analytics/read-models/tecnologiaKpi.settings');
const { IA_KPI_SETTINGS_SCHEMA } = require('../../features/analytics/read-models/iaKpi.settings');
const { QUALITY_SETTINGS_SCHEMA } = require('../../features/analytics/quality/quality.settings');
const { CACHE_SETTINGS_SCHEMA } = require('../../features/analytics/security/cache.settings');
const { MV_SETTINGS_SCHEMA } = require('../../features/analytics/read-models/matview.settings');
const { COMERCIAL_SETTINGS_SCHEMA } = require('../../features/analytics/read-models/comercial.settings');
const { IMOVEIS_KPI_SETTINGS_SCHEMA } = require('../../features/analytics/read-models/imoveisKpi.settings');
const { CORRETORES_KPI_SETTINGS_SCHEMA } = require('../../features/analytics/read-models/corretoresKpi.settings');
const { LOCACAO_SETTINGS_SCHEMA } = require('../../features/analytics/read-models/locacao.settings');
const { OBRA_SETTINGS_SCHEMA } = require('../../features/analytics/read-models/obra.settings');
const { OBRA_KPI_SETTINGS_SCHEMA } = require('../../features/analytics/read-models/obraKpi.settings');
const { OBRA_OPERACAO_SETTINGS_SCHEMA } = require('../../features/analytics/read-models/obraOperacaoKpi.settings');
const { OBRA_COST_KPI_SETTINGS_SCHEMA } = require('../../features/analytics/read-models/obraPerdasKpi.settings');
const { INV_KPI_SETTINGS_SCHEMA } = require('../../features/analytics/read-models/estoqueKpi.settings');
const { JURIDICO_SETTINGS_SCHEMA } = require('../../features/analytics/read-models/juridico.settings');
const { JUR_COR_KPI_SETTINGS_SCHEMA } = require('../../features/analytics/read-models/juridicoCorrespondenteKpi.settings');
const { SUPPORT_KPI_SETTINGS_SCHEMA } = require('../../features/analytics/read-models/atendimentoKpi.settings');
const { RENTAL_DEADLINES_KPI_SETTINGS_SCHEMA } = require('../../features/analytics/read-models/locacaoPrazosKpi.settings');
const { RENTAL_PORTFOLIO_KPI_SETTINGS_SCHEMA } = require('../../features/analytics/read-models/locacaoCarteiraKpi.settings');
const { RENTAL_CARE_KPI_SETTINGS_SCHEMA } = require('../../features/analytics/read-models/locacaoAtendimentoKpi.settings');
const { MKT_ATENDIMENTO_SETTINGS_SCHEMA } = require('../../features/analytics/read-models/marketingAtendimento.settings');
const { MKT_KPI_SETTINGS_SCHEMA } = require('../../features/analytics/read-models/marketingKpi.settings');
const { COMMAND_SETTINGS_SCHEMA } = require('../../features/analytics/read-models/commandEvents.settings');
const { CENTRO_SETTINGS_SCHEMA } = require('../analytics/centroSettings'); // M9-D685
const { HEALTH_SETTINGS_SCHEMA: SAUDE_GERAL_SETTINGS_SCHEMA } = require('../analytics/healthSettings'); // M9-D686
const { NAY_TOOLS_SETTINGS_SCHEMA } = require('../../features/analytics/nayToolsSettings');
const { SNAPSHOT_SETTINGS_SCHEMA } = require('../../features/analytics/metrics/snapshots.settings');
const { BI_ALERT_SETTINGS_SCHEMA } = require('../../features/analytics/alerts/engine.settings');
const { BRIEF_SETTINGS_SCHEMA } = require('../../features/analytics/briefSettings');
const { EXPORT_SETTINGS_SCHEMA } = require('../../features/analytics/exports/export.settings');
const { ACCEPTANCE_SETTINGS_SCHEMA } = require('../../features/analytics/metrics/acceptance.settings');

/**
 * SETTINGS_SCHEMA — dicionário fail-closed de chaves conhecidas do painel admin de
 * configurações por tenant. `upsertSetting` REJEITA (400) qualquer chave que não esteja aqui
 * ou qualquer valor fora da faixa/tipo esperado — nunca aceita "o que vier" silenciosamente.
 *
 * DECISÃO DE ENGENHARIA — não especificado no Caderno: as faixas abaixo (0-100% para
 * percentuais, 1-120 minutos para janela de MFA) são limites de sanidade de engenharia (evitar
 * configuração absurda, ex. multa de 500% ou step-up de 0 minutos), não um requisito de negócio
 * documentado — a confirmar com o cliente antes de produção.
 */
const SETTINGS_SCHEMA = {
  // Financeiro (aba "Financeiro" de Configurações): antifraude FIN-005, conciliação manual recorrente (§17) e política AUTO_STRONG (§11), com faixas.
  ...FINANCE_SETTINGS_SCHEMA,
  // EST-013 / Guia §12 (NAY Estoque, inventoryNay.service.js): lead time padrão (dias) usado
  // pela sugestão de compra quando o item ainda não tem histórico real de reposição
  // (pedido de compra -> recebimento) para medir o prazo observado.
  'inventory.nay_default_lead_time_days': { type: 'integer', min: 0, max: 365 },
  // Marco 6 (matriz de fechamento, 10/11/2026): base do custo financeiro realizado das obras — lacuna do Caderno
  // (Construção §5 actual_financial_cost). CAIXA = só o pago (padrão, comportamento anterior); COMPETENCIA = soma as
  // medições aprovadas ainda a pagar (src/features/construction/costBasis.js). Gravação exige construction:approve.
  'construction.custo_realizado.base': { type: 'string', enum: ['CAIXA', 'COMPETENCIA'] },
  // parametros.csv exige_mfa_para_alterar = sim (settingMfa.js): multa, juros e carência só mudam com MFA recente de quem altera.
  'billing.late_fee_percentage': { type: 'number', min: 0, max: 100, requiresMfa: true },
  'billing.interest_percentage': { type: 'number', min: 0, max: 100, requiresMfa: true },
  'billing.grace_period_days': { type: 'integer', min: 0, requiresMfa: true },
  'billing.default_index_code': { type: 'string' },
  'mfa.step_up_ttl_minutes': { type: 'integer', min: 1, max: 120, requiresMfa: true },
  'mfa.required_for_sensitive_roles': { type: 'boolean', requiresMfa: true },
  'legal.signature_provider': { type: 'string', enum: ['sandbox', 'sandbox-alt', 'clicksign', 'zapsign'] },
  // Campos abaixo são segredos de provedor externo — CRIPTOGRAFADOS em repouso (AES-256-GCM,
  // ver src/utils/mfaCrypto.js) seguindo o mesmo padrão já usado para o segredo TOTP
  // (src/features/users/mfa.service.js). `upsertSetting` criptografa antes de gravar;
  // `getDecryptedSetting` é o único ponto que decifra, e só no escopo da chamada que precisa
  // do valor em texto claro (nunca guardar o valor decifrado além disso).
  'legal.clicksign_api_token': { type: 'string', encrypted: true },
  // A conta do Clicksign (token de "Access token" no painel) é OU produção OU sandbox — nunca
  // as duas; um token de produção é rejeitado (401) contra a URL de sandbox e vice-versa. Sem
  // esse dado, o adapter não tem como saber qual base URL usar (ver ClicksignSignatureAdapter).
  'legal.clicksign_environment': { type: 'string', enum: ['production', 'sandbox'] },
  'legal.zapsign_api_token': { type: 'string', encrypted: true },
  'legal.clicksign_webhook_secret': { type: 'string', encrypted: true },
  'legal.zapsign_webhook_secret': { type: 'string', encrypted: true },
  'billing.igpm_mode': { type: 'string', enum: ['manual', 'automatic'] },
  'billing.fgv_api_token': { type: 'string', encrypted: true },
  // Provider bancário (PaymentProvider/BankAdapter) — mesmo padrão de legal.signature_provider.
  // Ver PROVIDER_BANCARIO.md. "sandbox" é o default seguro: sem credencial configurada, o
  // resolver cai pra SandboxBankAdapter e nenhum fluxo de negócio trava.
  'finance.payment_provider': { type: 'string', enum: ['sandbox', 'santander'] },
  'finance.santander_environment': { type: 'string', enum: ['sandbox', 'production'] },
  'finance.santander_workspace_id': { type: 'string' },
  'finance.santander_client_id': { type: 'string', encrypted: true },
  'finance.santander_client_secret': { type: 'string', encrypted: true },
  // Certificado A1 mTLS exigido pela API do Santander — par chave/certificado, ambos em texto
  // PEM, criptografados em repouso como qualquer outro segredo de provider.
  'finance.santander_cert_pem': { type: 'string', encrypted: true },
  'finance.santander_key_pem': { type: 'string', encrypted: true },
  // BUG REAL CORRIGIDO (auditoria "loop até secar", rodada 38, 2026-10-05): mesma falha de
  // segurança do webhook de seguro (corrigida na R37) — bankPaymentPublicWebhook nunca validava
  // assinatura nenhuma, permitindo forjar confirmação de pagamento bancário real. Mesmo esquema
  // HMAC-SHA256 por tenant, fail-closed quando há provider real configurado.
  'finance.bank_payment_webhook_secret': { type: 'string', encrypted: true },
  // Insurance Hub (Marco 7 — "COMPRAS/PROCUREMENT + SEGUROS", InsuranceAdapter). Mesmo padrão:
  // "sandbox" é o default seguro, resolver cai pra SandboxInsuranceAdapter sem credencial.
  // "junto_seguros" fica como enum válido (selecionável no front, documentado como "pendente de
  // parceria de corretora") mas NUNCA tem settings de credencial aqui — não há documentação
  // técnica pública pra essa seguradora, então não existe campo real pra pedir (ver
  // InsuranceAdapter.js — JuntoSegurosInsuranceAdapter lança sempre que instanciada).
  'procurement.insurance_provider': { type: 'string', enum: ['sandbox', 'porto_seguro', 'junto_seguros', 'yelum', 'manual'] }, // 'manual' (M9-D238): seguradora sem API, com tarefas a uma pessoa
  // Porto Seguro: OAuth2 client_credentials CONFIRMADO (dev.portoseguro.com.br/api-portal/
  // content/autorizacao) — client_id/client_secret, não um api_key único.
  'procurement.porto_seguro_environment': { type: 'string', enum: ['sandbox', 'production'] },
  'procurement.porto_seguro_client_id': { type: 'string', encrypted: true },
  'procurement.porto_seguro_client_secret': { type: 'string', encrypted: true },
  'procurement.yelum_environment': { type: 'string', enum: ['sandbox', 'production'] },
  'procurement.yelum_api_key': { type: 'string', encrypted: true },
  // BUG REAL CORRIGIDO (auditoria "loop até secar", rodada 37, 2026-10-05): o webhook público
  // de seguradora (insurancePublicWebhook) não validava assinatura nenhuma — qualquer
  // requisição que conhecesse o externalSubmissionId conseguia forjar liquidação de sinistro e
  // lançamento financeiro arbitrário. Mesmo padrão já usado pro Clicksign
  // (legal.clicksign_webhook_secret) — um secret por tenant, HMAC-SHA256 do corpo bruto.
  'procurement.insurance_webhook_secret': { type: 'string', encrypted: true },
  // Marco 8 — Correspondente Bancário + Financiamentos (Fase 0, ProviderAdapter). Mesmo padrão
  // dos demais: "sandbox" é o default seguro, "manual" é o workflow assistido do Caderno
  // ("Provider sem API usa workflow manual assistido"). Nenhum banco real integrado ainda nesta
  // fase — quando a Nayara formalizar parceria com um banco/financeira, o nome entra aqui como
  // novo valor de enum, igual Porto Seguro/Yelum entraram em procurement.insurance_provider.
  'correspondent.financing_provider': { type: 'string', enum: ['sandbox', 'manual'] },
  // Secret HMAC-SHA256 do webhook do provider sandbox (`verifyWebhook` em
  // FinancingProviderAdapter.js) — mesmo padrão de procurement.insurance_webhook_secret.
  'correspondent.sandbox_webhook_secret': { type: 'string', encrypted: true },
  // Marco 9 — governança (M9-D800): liga/desliga dos 8 módulos, exceções ao prefixo GOV_ e perfis da concessão padrão.
  ...GOVERNANCE_SETTINGS_SCHEMA,
  // Pessoas (DI-M9I-5): limite de tentativas de vínculo que não conferem por usuário e janela.
  ...PEOPLE_LINK_SETTINGS_SCHEMA,
  // Pessoas (DI-M3PE-2/3/6): catálogo de papéis, deduplicação (DDI, motivo mínimo da exceção, contato no grupo) e cadastro por documento.
  ...PEOPLE_M3PE_SETTINGS_SCHEMA,
  // Marco 9, M9-D003 — chave geral da NAY (ia.habilitada, padrão Desligado) e chave por agente (ai.agents.enabled).
  ...AI_SETTINGS_SCHEMA,
  // Marco 9, M9-D402 — Marketing: tetos de mensagem em massa e nomes dos perfis da concessão padrão.
  ...MARKETING_SETTINGS_SCHEMA,
  // Marco 9, M9-D403 — campos publicáveis (allowlist) e características permitidas em conteúdo público.
  ...PUBLIC_FIELDS_SETTINGS_SCHEMA,
  // Marco 9, M9-D404 — canais cujo template precisa de referência oficial aprovada no provedor.
  ...TEMPLATE_SETTINGS_SCHEMA,
  // Marco 9, M9-D412 — destinatários processados por step a cada rodada do job de campanhas.
  ...CAMPAIGN_SETTINGS_SCHEMA,
  // Marco 9, M9-D432 - custo real da campanha: fonte Financeiro ativa e intervalo de recalculo.
  ...COST_SETTINGS_SCHEMA,
  // Marco 9, M9-D419 — campos proibidos como critério de segmentação (dado sensível).
  ...SEGMENT_SETTINGS_SCHEMA,
  // Marco 9, M9-D406 — antecedência mínima do agendamento de conteúdo do Marketing.
  ...PIPELINE_SETTINGS_SCHEMA,
  // Marco 9, M9-D410 — paginação da listagem de publicações (padrão e máximo).
  ...SCHEDULE_SETTINGS_SCHEMA,
  // Marco 9, M9-D411 — worker de publicação: intervalo, lote, espera das retentativas, tentativas, reconciliação, limite do UNKNOWN, tempo do adapter e dias das métricas.
  ...WORKER_SETTINGS_SCHEMA,
  // Marco 9, M9-D442 — failure drill de provedor: publicações que esperam com o circuito aberto e a margem do cenário SLOW.
  ...DRILL_SETTINGS_SCHEMA,
  // Marco 9, M9-D420 — lead novo (prazo da tarefa, origens) e cliente frio (dias sem interação, limite de mensagens e janela móvel, tipos de conteúdo aprovado).
  ...LEAD_PARAMS_SCHEMA,
  // Marco 9, M9-D408 — classes de conteúdo da NAY autorizadas a sair sem aprovação humana (escrita exige marketing:automation:manage).
  ...AUTOPUBLISH_SETTINGS_SCHEMA,
  // Marco 9, M9-D414 — runner de automações: tempo máximo de cada ação e ordem dos canais automáticos.
  ...RUNNER_SETTINGS_SCHEMA,
  // Marco 9, M9-D409 — tipos de conteúdo: hora do aniversário, casas do percentual, fotos mínimas, tipos com rascunho automático, finalidade do pós-venda e varredura de obras.
  ...TYPES_SETTINGS_SCHEMA,
  // Marco 9, M9-D407 — validador factual: tolerância de área, dicionário de características e telefones da empresa.
  ...FACTUAL_SETTINGS_SCHEMA,
  // Marco 9, M9-D431 — janela da atribuição (first-touch e last-touch) em dias.
  ...TRACKING_SETTINGS_SCHEMA,
  // Marco 9, M9-D417 — cadência, quiet hours e frequency cap do Marketing (lidos por getMarketingParam; escrita exige marketing:automation:manage).
  ...CADENCE_SETTINGS_SCHEMA,
  ...SEEDS_SETTINGS_SCHEMA, // M9-D422 a M9-D424: cadência de locação, link da pesquisa, lembretes de restrição e pedido de avaliação
  // Marco 9, M9-D430 — liberação por canal (só o serviço releaseChannel grava) e tempos do sandbox dos adapters de canal.
  ...CHANNEL_SETTINGS_SCHEMA,
  // Marco 9, M9-D418 — listas de finalidade do consentimento, palavras de opt-out e janela de atendimento do canSend.
  ...SUPPRESSION_SETTINGS_SCHEMA,
  // Marco 9, M9-D427 — SEO do site (política de página vendida/removida, dias, URL base) e blog educativo (fontes permitidas, mínimo de palavras, aviso de IA).
  ...SEO_SETTINGS_SCHEMA,
  // Marco 9, M9-D433 — URL externa: domínios extras, encurtadores, saltos, tamanho, verificação de destino e espera.
  ...URL_SETTINGS_SCHEMA,
  ...URL_LIMITS_SCHEMA, // M9-D414 (rodada 4): tetos de tamanho da varredura de URL e política do candidato ambíguo sem aprovador
  ...BLOG_SETTINGS_SCHEMA,
  // Marco 9, M9-D429 — preview sem dado sensível (tamanho, dicionários, número de contrato, texto seguro) e endereço do descadastro do e-mail.
  ...PREVIEW_SETTINGS_SCHEMA,
  ...KILLSWITCH_SETTINGS_SCHEMA,
  // Marco 9, M9-D426 — vídeo e mídia: política de transparência, textos dos avisos, origens aceitas e máximo de mídias da montagem.
  ...VIDEO_SETTINGS_SCHEMA,
  // Marco 9, M9-D428 — redes sociais: capabilities de cada rede (JSON), marca de idempotência do post, prefixo da hashtag técnica e tolerância de proporção.
  ...SOCIAL_SETTINGS_SCHEMA,
  // Marco 9, M9-D200 — registro de integrações (integration.providers/connections). Tudo que o
  // livro deixa em aberto é decidido pelo administrador; o padrão é o valor de _parametros-bloco-B.csv.
  // INT-P091: mudança de conexão em PRODUÇÃO e teste de conexão em produção exigem MFA recente.
  'integration.admin.mfa_on_prod_test_connection': { type: 'boolean', requiresMfa: true },
  'integration.admin.mfa_on_prod_connection_change': { type: 'boolean', requiresMfa: true },
  // Tamanho mínimo (caracteres) de texto base64/hex sem espaço tratado como segredo embutido em config_json/policy_json.
  'integration.registry.secret_scan_min_length': { type: 'integer', min: 24, max: 256, requiresMfa: true },
  // Resolução por domínio quando há mais de uma conexão ACTIVE no mesmo domínio e ambiente.
  'integration.registry.domain_resolution': { type: 'string', enum: ['error_if_multiple', 'oldest_active', 'newest_active'], requiresMfa: true },
  // M9-D204: esperas (ms) entre as tentativas de publicação interna do outbox; o tamanho da lista é o limite de tentativas.
  'integration.outbox.backoff_ms': {
    type: 'string',
    validate: (key, value) => {
      if (!parseBackoffList(value)) {
        throw AppError.badRequest(`O valor de "${key}" deve ser uma lista de milissegundos inteiros positivos separados por vírgula (ex.: 60000,300000).`, 'SETTING_INVALID_VALUE', { key });
      }
    },
  },
  // Marco 9, M9-D201 — criticidade de cada uma das 14 famílias do catálogo (integration.catalog.criticality.<domínio>).
  ...CATALOG_SETTINGS_SCHEMA,
  // Marco 9, M9-D202 — cofre de segredos: cache, janela de graça, idade máxima BANK, avisos, prefixo da empresa e MFA do BANK.
  ...SECRET_SETTINGS_SCHEMA,
  // Marco 9, M9-D206 — saúde dos fornecedores: dado velho, janela do job, retenção, falhas até DOWN e meta de SLO por criticidade.
  ...HEALTH_SETTINGS_SCHEMA,
  // Marco 9, M9-D217 — circuit breaker: falhas seguidas até abrir, cooldown, chamadas de teste em HALF_OPEN, sucessos para fechar e espera de quem não coube.
  ...CIRCUIT_SETTINGS_SCHEMA,
  // Marco 9, M9-D224 — alertas das integrações: repetição (antiflap), papéis avisados, minutos de circuito aberto até alertar e intervalo da avaliação.
  ...ALERT_SETTINGS_SCHEMA,
  // Marco 9, M9-D207 — erros de integração: janela de agrupamento, retenção e tentativas até a severidade subir.
  ...ERRORS_SETTINGS_SCHEMA,
  // Marco 9, M9-D208 — sincronização retomável: página, lease, sobreposição, falhas até parar e limite de sync parado por criticidade.
  ...SYNC_SETTINGS_SCHEMA,
  // Marco 9, M9-D203 — caixa de entrada de webhooks: tentativas, retenção do corpo e da linha, espera entre tentativas, tamanho e cabeçalhos guardados.
  ...INBOX_SETTINGS_SCHEMA,
  // Marco 9, M9-D211 — rota pública de webhooks: alias da raiz, limite por minuto (classe WEBHOOK) e tamanho do token do canal.
  ...WEBHOOK_SETTINGS_SCHEMA,
  ...SIGNATURE_SETTINGS_SCHEMA,
  // Marco 9, M9-D237 — pagamento bancário: página do extrato, tolerância de data da conciliação, idade mínima da consulta e confirmação sem valor informado.
  ...BANK_SETTINGS_SCHEMA,
  // Marco 9, M9-D232 — portais: intervalo da leitura de status dos anúncios e anúncios por página do sync.
  ...PORTAL_SETTINGS_SCHEMA,
  // Marco 9, M9-D242 — armazenamento de objetos (validade máxima da URL assinada, driver padrão, tamanho máximo) e identidade (acesso local na contingência, relógio, JWKS, algoritmos).
  ...STORAGE_SETTINGS_SCHEMA,
  ...IDENTITY_SETTINGS_SCHEMA,
  // Marco 9, M9-D259 — páginas do site: idioma padrão da página publicada.
  ...SITE_SETTINGS_SCHEMA,
  // Marco 9, M9-D247 — quarentena de uploads externos: tamanho máximo, prazo, razão e profundidade do arquivo compactado e tipos aceitos.
  ...QUARANTINE_SETTINGS_SCHEMA,
  // Marco 9, M9-D205 — envios a fornecedores: espera até SENDING virar UNKNOWN, retenção do envio e do conteúdo, tentativas máximas.
  ...DISPATCH_SETTINGS_SCHEMA,
  // Marco 9, M9-D238 — seguradoras: marcos de vencimento, cotação de renovação e prazo da tarefa manual.
  ...INSURANCE_SETTINGS_SCHEMA,
  // Marco 9, M9-D241 — NFS-e: série do RPS da empresa.
  ...NFSE_SETTINGS_SCHEMA,
  // Marco 9, M9-D226 — contingência das integrações: testes de saúde para encerrar, prazo da fila por modo (e do banco), papéis avisados e responsável da tarefa manual.
  ...CONTINGENCY_SETTINGS_SCHEMA,
  // Marco 9, M9-D250 — ações do operador: tempo do teste de conexão, tentativas extras do retry humano e MFA na rotação de credencial.
  ...ACTIONS_SETTINGS_SCHEMA,
  // Marco 9, M9-D219 — minimização dos dados enviados: classificação máxima por família (só pode ser mais restritiva que o livro).
  ...MINIMIZATION_SETTINGS_SCHEMA,
  // Marco 9, M9-D231 — publicação do site e dos portais: raio da coordenada aproximada (até 300 m).
  ...PUBLICATION_SETTINGS_SCHEMA,
  // Marco 3 §7 e §14 (verificação de 11/11/2026): documentos e campos obrigatórios do gate de publicação e validade do link do carrinho.
  ...PROPERTY_PUBLICATION_SETTINGS_SCHEMA,
  ...CART_SETTINGS_SCHEMA,
  // Marco 9, M9-D209 — contrato de adapters: tempo do teste de saúde e das chamadas de leitura e escrita ao fornecedor.
  ...ADAPTERS_SETTINGS_SCHEMA,
  // Marco 9, M9-D229 — mensageria do CRM: código do país do telefone E.164 e prazo da primeira ação do lead provisório.
  ...MESSAGING_SETTINGS_SCHEMA,
  // Marco 3 §18 / CRM-TS-012 (DI-M3CB-1): política de equipe da carteira para registro do CRM sem oportunidade.
  ...CARTEIRA_SETTINGS_SCHEMA,
  // DEC-049 (X45-D018): teto de linhas e MFA da exportação de oportunidades do CRM.
  ...CRM_EXPORT_SETTINGS_SCHEMA,
  ...CRM_SETTINGS_SCHEMA,
  // Marco 9, M9-D222 — contract tests dos adapters: validade do relatório que libera a connection.
  ...CONTRACT_SETTINGS_SCHEMA,
  // Marco 9, M9-D220 — integridade do domínio: tempo que a ação do usuário espera o fornecedor antes de responder "aceito".
  ...DOMAIN_SETTINGS_SCHEMA,
  // Marco 9, M9-D248 — auditoria de dependências e SDKs: versão exata, lista de SDKs, validade da exceção e hora do job diário.
  ...DEPAUDIT_SETTINGS_SCHEMA,
  // Marco 9, M9-D244 — modo da allowlist de saída (enforce ou log) e hora do job de retenção que chama integration.purge_expired().
  ...TRANSPORT_SETTINGS_SCHEMA,
  ...RETENTION_SETTINGS_SCHEMA,
  // Marco 9, M9-D255 e M9-D256 — tamanho do teste de carga das integrações e portão de liberação para produção.
  ...LOAD_INTEGRATION_SETTINGS_SCHEMA,
  ...RELEASE_SETTINGS_SCHEMA,
  // Marco 9, M9-D612 — BI somente leitura: usar o role de banco sem escrita nos GET de /analytics (padrão Ligado).
  ...READ_ONLY_SETTINGS_SCHEMA,
  // Marco 9, M9-D700 / M9-D687 — segurança do BI (mapa de domínio x permissão, equipes, campos extras mascarados, log de abertura, p95 padrão).
  ...SECURITY_SETTINGS_SCHEMA,
  // Marco 9, M9-D604 — versionamento de métricas do BI: mínimo de caracteres do motivo da mudança de fórmula.
  ...METRICS_SETTINGS_SCHEMA,
  // Marco 9, M9-D607 — atualização dos read models do BI: teto de linhas por evento, intervalo do lote, lote e agenda do job, tempo máximo da consulta.
  ...READ_MODEL_SETTINGS_SCHEMA,
  // Marco 9, M9-D608 — rebuild de read model: habilitar (LIGADO em LAB, DESLIGADO em produção) e janela de busca dos eventos aplicados durante a reconstrução.
  ...REBUILD_SETTINGS_SCHEMA,
  // Marco 9, M9-D611 — rastreio do número até a origem: quantos ids acompanham cada indicador.
  ...SOURCE_REFS_SETTINGS_SCHEMA,
  ...DRILLDOWN_SETTINGS_SCHEMA, // M9-D690: tamanho de página do detalhe (drill-down)
  // Marco 9, M9-D615 — read model financeiro: janela, em dias, do vencido que entra na taxa de inadimplência.
  ...FINANCE_HEALTH_SETTINGS_SCHEMA,
  // Marco 9, M9-D624 — KPIs de conciliações pendentes e anomalias: idade máxima do extrato, faixas de idade e owner de cada KPI.
  ...FINANCE_KPI_SETTINGS_SCHEMA,
  // Marco 9, M9-D620 — KPIs de caixa livre e dinheiro de terceiros: saldo de abertura, termos de origem (caução, repasse), mapa de status do ledger e owners.
  ...CASH_SETTINGS_SCHEMA,
  ...FINANCE_WINDOW_SETTINGS_SCHEMA,
  // Marco 9, M9-D630 / M9-D631 — KPIs do funil comercial: owner de cada KPI, limites de qualidade (origem vazia, sem motivo, amostra mínima, sem corretor) e ordem dos estágios.
  ...CRM_KPI_SETTINGS_SCHEMA,
  ...FINANCE_RESULT_SETTINGS_SCHEMA,
  // Marco 9, M9-D622 — KPIs de inadimplência: faixas de atraso do valor inadimplente e owner de cada um dos três indicadores.
  ...FINANCE_DELINQUENCY_SETTINGS_SCHEMA,
  // Marco 9, M9-D626 — painel Financeiro: limiar dos cartões de conciliações pendentes e anomalias abertas quando não há alerta publicado.
  ...PANEL_SETTINGS_SCHEMA,
  // Marco 9, M9-D699 — teste de carga do BI: quanto o p95 do fluxo operacional pode subir com os painéis sob carga.
  ...LOAD_SETTINGS_SCHEMA,
  // Marco 9, M9-D702 — API de métricas: quantas linhas da decomposição por dimensão a resposta traz.
  ...QUERY_SETTINGS_SCHEMA,
  // Marco 9, M9-D709 — fila de decisão do Centro de Comando: owner de cada KPI e idade a partir da qual o item pendente é "envelhecido".
  ...DECISAO_FILA_SETTINGS_SCHEMA,
  // Marco 9, M9-D628 — read models de Tecnologia e IA: histórico em dias, sondas ligadas, intervalo das sondas e retenção dos sinais técnicos.
  ...TECH_SETTINGS_SCHEMA,
  // Marco 9, M9-D680 — KPIs de Tecnologia: owner de cada um, janela de erro das integrações, limiar de falhas de autenticação, sondas ausentes, fila sem medição e motivos de bloqueio.
  ...TECH_KPI_SETTINGS_SCHEMA,
  // Marco 9, M9-D681 — KPIs de IA: owner de cada um, limite de alerta do orçamento, semanas de histórico da qualidade e motivos de bloqueio com linha própria.
  ...IA_KPI_SETTINGS_SCHEMA,
  // Marco 9, M9-D696 — qualidade de dados do BI: faixa de linhas, nulos, tolerância da conciliação, severidades e limites de freshness por domínio.
  ...QUALITY_SETTINGS_SCHEMA,
  // Marco 9, M9-D698 — desempenho do BI: TTL do cache dos painéis (analytics.cache.ttl_segundos) e agenda das materialized views (analytics.mv.schedule).
  ...CACHE_SETTINGS_SCHEMA,
  ...MV_SETTINGS_SCHEMA,
  // Marco 9, M9-D616 / M9-D617 — read models de Comercial/Imóveis (oportunidade parada, janela de recálculo, faixas sem venda) e de Locação (tipos de contrato, prazo do repasse, notas).
  ...COMERCIAL_SETTINGS_SCHEMA,
  ...IMOVEIS_KPI_SETTINGS_SCHEMA,
  ...CORRETORES_KPI_SETTINGS_SCHEMA,
  ...LOCACAO_SETTINGS_SCHEMA,
  // Marco 9, M9-D618 — read models de Obras e Estoque: método de previsão, status de contrato da receita e tipos de item do estoque.
  ...OBRA_SETTINGS_SCHEMA,
  // Marco 9, M9-D652 / M9-D653 — KPIs de desperdício, custo pós-obra, recorrência e de Estoque/Patrimônio: owner de cada KPI e janela, mínimo e tamanho do ranking da recorrência.
  ...OBRA_COST_KPI_SETTINGS_SCHEMA,
  ...INV_KPI_SETTINGS_SCHEMA,
  // Marco 9, M9-D650 / M9-D651 — KPIs de Obras no BI: owner de cada indicador e limite de não conformidade sem causa.
  ...OBRA_KPI_SETTINGS_SCHEMA,
  // Marco 9, M9-D651 — KPIs de Obras no BI (atrasos, medições e não conformidades): owner de cada indicador e limite de não conformidade sem causa.
  ...OBRA_OPERACAO_SETTINGS_SCHEMA,
  // Marco 9, M9-D619 — read models do Jurídico: status que tiram o processo de "ativo".
  ...JURIDICO_SETTINGS_SCHEMA,
  // Marco 9, M9-D660 / M9-D661 — KPIs do Jurídico e do Correspondente: owner de cada um, limites de qualidade e estágios do caso.
  ...JUR_COR_KPI_SETTINGS_SCHEMA,
  // Marco 9, M9-D672 — KPIs de Atendimento: owner de cada um, horas e severidades do SLA por prioridade e limite de reclamações sem motivo.
  ...SUPPORT_KPI_SETTINGS_SCHEMA,
  // Marco 9, M9-D641 — KPIs de prazos da Locação: owner de cada um e tipos de garantia que não têm vencimento.
  ...RENTAL_DEADLINES_KPI_SETTINGS_SCHEMA,
  // Marco 9, M9-D640 — KPIs da carteira de Locação: owner de contratos ativos, vacância e inadimplência da locação e faixas de valor do aluguel.
  ...RENTAL_PORTFOLIO_KPI_SETTINGS_SCHEMA,
  // Marco 9, M9-D642 — KPIs de chamados, satisfação e repasses da Locação: owner de cada um.
  ...RENTAL_CARE_KPI_SETTINGS_SCHEMA,
  // Marco 9, M9-D627 — read models de Marketing e Atendimento: dias que a agenda reconfere.
  ...MKT_ATENDIMENTO_SETTINGS_SCHEMA,
  // Marco 9, M9-D670 / M9-D671 — KPIs de Marketing no BI: owner de cada um, janela da frequência e limites de qualidade.
  ...MKT_KPI_SETTINGS_SCHEMA,
  // Marco 9, M9-D710 — fatos do dia do Centro de Comando: janela em horas, valor relevante de pagamento e owner dos três indicadores.
  ...COMMAND_SETTINGS_SCHEMA,
  ...CENTRO_SETTINGS_SCHEMA, // M9-D685
  ...SAUDE_GERAL_SETTINGS_SCHEMA, // M9-D686
  // Marco 9, M9-D695 — ferramentas da NAY Diretoria no BI: tamanho máximo das listas devolvidas.
  ...NAY_TOOLS_SETTINGS_SCHEMA,
  // Marco 9, M9-D609 — snapshot diário do BI: hora de execução (padrão 00:30 de São Paulo) e limite de dias do catch-up.
  ...SNAPSHOT_SETTINGS_SCHEMA,
  // Marco 9, M9-D691 — alert engine: cooldown por severidade, avaliações para resolver, intervalo, owner reserva e os alertas semente.
  ...BI_ALERT_SETTINGS_SCHEMA,
  // Marco 9, M9-D693 / M9-D694 — briefing da NAY Diretoria: horários, limite de itens, papel e áreas, variação relevante, polaridade, fontes de causa e fechamentos.
  ...BRIEF_SETTINGS_SCHEMA,
  // Marco 9, M9-D701 — exportação do BI: limite de linhas de alto risco (MFA), validade do arquivo, validade do endereço, teto de linhas e tempo máximo de execução.
  ...EXPORT_SETTINGS_SCHEMA,
  // Marco 9, M9-D708 — ambiente do BI (LAB ou PRODUCAO, com a trava do aceite dos owners) e tolerância da diferença no aceite.
  ...ACCEPTANCE_SETTINGS_SCHEMA,
  // M9-D002: guardar conversa inteira como memória da NAY (padrão Desligado; o Ligado vale só pela regra única de M9-D009).
  'ia.memoria.guardar_conversa_inteira': { type: 'boolean' },
  // Fechamento M5 — Locação (o que o livro não fixa vira parâmetro; padrão = comportamento anterior/livro).
  'legal.inspection_default_room_code': { type: 'string' },
  'legal.guarantee_other_flows': { type: 'string' }, // JSON: [{ "code", "label", "requiredFields": [] }] — vazio = nenhuma "outra" homologada
  'locacao.titularidade.prazo_dias': { type: 'integer', min: 1, max: 90 },
  ...Object.fromEntries(['WATER', 'ELECTRICITY', 'GAS', 'CONDO', 'IPTU', 'SPU', 'OTHER'].map((t) => [
    `locacao.obrigacoes.periodicidade.${t}`, { type: 'string', enum: ['MONTHLY', 'BIMONTHLY', 'QUARTERLY', 'SEMIANNUAL', 'ANNUAL', 'ONE_TIME'] },
  ])),
};

/** Tira de `details` o valor recebido (`value`) de uma recusa de configuração; o resto do erro fica igual. */
function semValorRecebido(err) {
  if (err && err.details && typeof err.details === 'object' && !Array.isArray(err.details) && Object.prototype.hasOwnProperty.call(err.details, 'value')) {
    const { value: _recebido, ...resto } = err.details;
    err.details = resto;
  }
  return err;
}

function validateAgainstSchema(key, value) {
  const spec = SETTINGS_SCHEMA[key];
  if (!spec) {
    throw AppError.badRequest(`Chave de configuração desconhecida: "${key}".`, 'SETTING_UNKNOWN_KEY', { key });
  }

  if (spec.type === 'number' || spec.type === 'integer') {
    // Chave com `label`/`invalidStatus` (antifraude, DI-DEC007-2): frase com o rótulo e a faixa, e o status do dono (422); demais chaves: 400 de antes.
    const { invalidNumberValue } = require('./settingInvalidValue');
    if (typeof value !== 'number' || !Number.isFinite(value)) throw invalidNumberValue(key, spec, value, `O valor de "${key}" deve ser numérico.`);
    if (spec.type === 'integer' && !Number.isInteger(value)) throw invalidNumberValue(key, spec, value, `O valor de "${key}" deve ser um número inteiro.`);
    if (spec.min !== undefined && value < spec.min) throw invalidNumberValue(key, spec, value, `O valor de "${key}" deve ser >= ${spec.min}.`);
    if (spec.max !== undefined && value > spec.max) throw invalidNumberValue(key, spec, value, `O valor de "${key}" deve ser <= ${spec.max}.`);
    return;
  }

  if (spec.type === 'boolean') {
    if (typeof value !== 'boolean') {
      throw AppError.badRequest(`O valor de "${key}" deve ser booleano.`, 'SETTING_INVALID_VALUE', { key });
    }
    if (typeof spec.validate === 'function') spec.validate(key, value); // M9-D852: regra própria da chave (ex.: debug proibido em produção)
    return;
  }

  if (spec.type === 'string') {
    if (typeof value !== 'string' || value.trim() === '') {
      throw AppError.badRequest(`O valor de "${key}" deve ser uma string não vazia.`, 'SETTING_INVALID_VALUE', { key });
    }
    if (Array.isArray(spec.enum) && !spec.enum.includes(value)) {
      throw AppError.badRequest(
        `O valor de "${key}" deve ser um dos seguintes: ${spec.enum.join(', ')}.`,
        'SETTING_INVALID_VALUE',
        { key }
      );
    }
    // Validação própria da chave (ex.: lista de itens de um catálogo fechado).
    if (typeof spec.validate === 'function') spec.validate(key, value);
    return;
  }

  // Fail closed: tipo de schema desconhecido/não implementado nunca é aceito silenciosamente.
  throw AppError.badRequest(`Tipo de schema não suportado para "${key}".`, 'SETTING_SCHEMA_ERROR', { key });
}

/**
 * getSetting — nunca lança erro por ausência de configuração: se a chave não estiver
 * configurada para o tenant (ou se `tenant`/`transaction` estiverem ausentes/incompletos —
 * ex.: chamada fora de contexto de tenant), retorna `defaultValue` silenciosamente. Isso é
 * proposital: leitura de configuração é sempre "best effort com fallback seguro", nunca deve
 * derrubar um fluxo de negócio (ex.: cálculo de multa) por falta de configuração — quem decide
 * fail-closed é o Motor de Regras (ver collectionCase.service.js), não este helper.
 */
async function getSetting(key, tenant, transaction, defaultValue = null) {
  try {
    if (!tenant || !tenant.companyId) return defaultValue;
    const row = await TenantSetting.findOne({
      where: { companyId: tenant.companyId, key },
      transaction,
    });
    if (!row) return defaultValue;
    return row.value;
  } catch (err) {
    // Fail-safe: qualquer erro tratável (ex.: transaction inválida) retorna o default em vez
    // de propagar — leitura de configuração nunca deve derrubar o chamador.
    return defaultValue;
  }
}

/**
 * getDecryptedSetting — mesma semântica "best effort com fallback seguro" de `getSetting`,
 * mas para chaves marcadas `encrypted: true` no SETTINGS_SCHEMA: decifra o valor armazenado e
 * retorna o segredo em texto claro. O valor decifrado deve viver só no escopo da chamada que
 * o usa (ex.: montar o header Authorization de uma chamada HTTP) — nunca deve ser guardado em
 * memória além disso (cache, variável de módulo etc.). Qualquer falha (chave ausente, valor
 * corrompido, erro de decifragem) retorna `defaultValue` — nunca lança, pelo mesmo motivo de
 * `getSetting`: leitura de configuração não pode derrubar o fluxo de negócio.
 */
async function getDecryptedSetting(key, tenant, transaction, defaultValue = null) {
  const spec = SETTINGS_SCHEMA[key];
  if (!spec || !spec.encrypted) {
    // Fail closed: só decifra chaves explicitamente marcadas como segredo no schema.
    return defaultValue;
  }
  const raw = await getSetting(key, tenant, transaction, null);
  if (!raw) return defaultValue;
  try {
    return decryptSecret(raw);
  } catch (err) {
    return defaultValue;
  }
}

/**
 * upsertSetting — cria ou atualiza (UPSERT por UNIQUE(company_id, key)) uma configuração de
 * tenant. Fail closed: chave desconhecida ou valor fora do schema é rejeitado com AppError 400
 * ANTES de qualquer escrita no banco.
 */
// `options.platform`: quem grava declara ter integration:platform (obrigatório para chave `platformOnly`).
async function upsertSetting(key, value, tenant, actorUserId, transaction, options = {}) {
  if (!tenant || !tenant.groupId || !tenant.companyId) {
    throw AppError.badRequest('Contexto de tenant (groupId/companyId) é obrigatório para configurar settings.', 'SETTING_TENANT_REQUIRED');
  }

  // Permissão própria da chave (settingRestricted.js, M9-D870 R4-M1): quem informa as permissões que tem (`options.permissions`: PUT /settings, registro de flags) só grava com a do dono da regra.
  require('./settingWritePermission').assertWritePermission(key, options.permissions);
  // Chave só da plataforma (settingPlatform.js): vale na camada de escrita, para todo caminho; sem `options.platform` a gravação é recusada (antes de olhar o valor).
  if (isPlatformOnly(SETTINGS_SCHEMA[key]) && options.platform !== true) {
    throw AppError.forbidden('Este parâmetro só é alterado pela equipe da plataforma.', 'SETTING_PLATFORM_ONLY', { key });
  }
  // Chave sensível (`requiresMfa`, settingMfa.js): MFA recente de quem altera, em todo caminho, antes de olhar o valor e de qualquer escrita.
  await assertMfaForSettingWrite(key, SETTINGS_SCHEMA[key], actorUserId, transaction);
  // Rodada 7 (DI-M9R-19): a recusa nunca devolve o valor recebido (podia ser um segredo, ou uma estrutura enorme que derrubava a resposta de erro);
  // `details` leva só a chave. Vale para as regras próprias das chaves (whatsapp.settings.js, identity.settings.js ...) e para a trava do dono.
  try {
    validateAgainstSchema(key, value);
    // Trava de gravação do dono da regra (M9-D034): recusa o valor antes de qualquer escrita.
    await runSettingGuard(key, value, tenant, actorUserId, transaction);
  } catch (err) {
    throw semValorRecebido(err);
  }

  // Campos marcados `encrypted: true` no schema são criptografados ANTES de tocar o banco —
  // a coluna `value` (JSONB) nunca guarda o segredo em texto plano. `beforeJson`/`afterJson`
  // da auditoria também usam a linha já com o valor criptografado (row.toJSON()), então a
  // auditoria nunca expõe o segredo em texto claro.
  const spec = SETTINGS_SCHEMA[key];
  const storedValue = spec && spec.encrypted ? encryptSecret(value) : value;

  const existing = await TenantSetting.findOne({ where: { companyId: tenant.companyId, key }, transaction });
  const beforeJson = existing ? existing.toJSON() : null;

  let row;
  if (existing) {
    existing.value = storedValue;
    existing.updatedBy = actorUserId || null;
    await existing.save({ transaction });
    row = existing;
  } else {
    row = await TenantSetting.create(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        key,
        value: storedValue,
        createdBy: actorUserId || null,
        updatedBy: actorUserId || null,
      },
      { transaction }
    );
  }

  await registrarAuditoria(
    {
      groupId: tenant.groupId,
      companyId: tenant.companyId,
      actorUserId,
      action: beforeJson ? 'settings.update' : 'settings.create',
      entityType: 'TenantSetting',
      entityId: row.id,
      beforeJson,
      afterJson: row.toJSON(),
      reason: `Configuração "${key}" ${beforeJson ? 'atualizada' : 'criada'} para o tenant.`,
    },
    transaction
  );

  return row;
}

async function listSettingsByPrefix(prefix, tenant, transaction) {
  if (!tenant || !tenant.companyId) {
    throw AppError.badRequest('Contexto de tenant (companyId) é obrigatório para listar settings.', 'SETTING_TENANT_REQUIRED');
  }
  const where = { companyId: tenant.companyId };
  if (prefix) where.key = { [Op.like]: `${prefix}%` };
  return TenantSetting.findAll({ where, order: [['key', 'ASC']], transaction });
}

async function getSettingRow(key, tenant, transaction) {
  if (!tenant || !tenant.companyId) {
    throw AppError.badRequest('Contexto de tenant (companyId) é obrigatório para consultar settings.', 'SETTING_TENANT_REQUIRED');
  }
  const row = await TenantSetting.findOne({ where: { companyId: tenant.companyId, key }, transaction });
  if (!row) {
    throw AppError.notFound(`Configuração "${key}" não encontrada para este tenant.`, 'SETTING_NOT_FOUND');
  }
  return row;
}

const INTEGRATION_STATUS_TIMEOUT_MS = 5000;

// Painel de status das integrações (M9-D210): a chamada de teste também passa pelo cliente HTTP único.
// M9-D244: só os hosts desses testes de conexão podem ser chamados.
const statusHttp = new IntegrationHttpClient({ providerCode: 'integration-status', allowedHosts: ['sandbox.clicksign.com', 'app.clicksign.com', 'api.zapsign.com.br', 'api.fgvdados.fgv.br'] });

/**
 * pingProvider — executa `fn(signal)` (uma chamada HTTP real e barata ao provedor) sob um
 * timeout curto (5s por padrão), pra nunca travar a tela de configurações esperando resposta
 * de rede de terceiro. Nunca lança: qualquer falha (erro HTTP, rede, timeout) vira
 * `connected: false` com um motivo, e só timeout usa o reason 'timeout' explicitamente.
 */
async function pingProvider(fn, timeoutMs = INTEGRATION_STATUS_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await fn(controller.signal);
    return { connected: true };
  } catch (err) {
    if (err && err.name === 'AbortError') {
      return { connected: false, reason: 'timeout' };
    }
    return { connected: false, reason: 'auth_or_network_error' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * getIntegrationsStatus — pra cada integração externa configurável no painel (Clicksign,
 * ZapSign, FGV/IGPM), faz uma chamada real mínima ao provedor pra confirmar que o token
 * funciona, sem nunca devolver o segredo em texto claro (só usa o valor decifrado no escopo
 * desta chamada de rede, nunca no retorno). Se não houver token configurado para o provider
 * ativo, retorna `configured: false` e nem tenta testar rede.
 */
async function getIntegrationsStatus(tenant, transaction) {
  const checkedAt = new Date().toISOString();

  const result = {
    clicksign: { configured: false, connected: false, checkedAt },
    zapsign: { configured: false, connected: false, checkedAt },
    igpm: { configured: false, connected: false, checkedAt },
    bankPayment: { configured: false, connected: false, checkedAt },
    insurance: { configured: false, connected: false, checkedAt },
  };

  const signatureProvider = await getSetting('legal.signature_provider', tenant, transaction, 'sandbox');

  if (signatureProvider === 'clicksign') {
    const token = await getDecryptedSetting('legal.clicksign_api_token', tenant, transaction, null);
    if (token) {
      const environment = await getSetting('legal.clicksign_environment', tenant, transaction, 'production');
      const baseUrl = environment === 'sandbox' ? 'https://sandbox.clicksign.com/api/v3' : 'https://app.clicksign.com/api/v3';
      const ping = await pingProvider(async (signal) => {
        const response = await statusHttp.fetch(`${baseUrl}/envelopes?page%5Bsize%5D=1`, {
          headers: { Accept: 'application/vnd.api+json', Authorization: token },
          signal,
        });
        if (!response.ok) throw new Error(`Clicksign respondeu ${response.status}.`);
      });
      result.clicksign = { configured: true, checkedAt, ...ping };
    }
  } else if (signatureProvider === 'zapsign') {
    const token = await getDecryptedSetting('legal.zapsign_api_token', tenant, transaction, null);
    if (token) {
      const ping = await pingProvider(async (signal) => {
        const response = await statusHttp.fetch('https://api.zapsign.com.br/api/v1/docs/?limit=1', {
          headers: { Authorization: `Bearer ${token}` },
          signal,
        });
        if (!response.ok) throw new Error(`ZapSign respondeu ${response.status}.`);
      });
      result.zapsign = { configured: true, checkedAt, ...ping };
    }
  }

  // FGV/IGPM: só depende de rede quando o modo é 'automatic'. Em 'manual' (ou qualquer outro
  // valor não-automático) não há dependência externa nenhuma — é sempre "verde".
  const igpmMode = await getSetting('billing.igpm_mode', tenant, transaction, 'manual');
  if (igpmMode === 'automatic') {
    const token = await getDecryptedSetting('billing.fgv_api_token', tenant, transaction, null);
    if (token) {
      const period = new Date().toISOString().slice(0, 7).replace('-', '');
      const ping = await pingProvider(async (signal) => {
        const response = await statusHttp.fetch(`https://api.fgvdados.fgv.br/v1/indicadores/igpm/${period}`, {
          headers: { Authorization: `Bearer ${token}` },
          signal,
        });
        if (!response.ok) throw new Error(`FGV respondeu ${response.status}.`);
      });
      result.igpm = { configured: true, checkedAt, ...ping };
    }
  } else {
    result.igpm = { configured: true, connected: true, checkedAt };
  }

  // Santander (PROVIDER_BANCARIO.md): autenticação exige mTLS (certificado A1) + OAuth2, não um
  // simples bearer token, então aqui só confirmamos que as 5 credenciais necessárias estão
  // salvas — resolve-bank-adapter.js já usa essa mesma lista pra decidir entre o adapter real e o
  // Sandbox. Não há "ping" de rede real (não vale abrir uma conexão mTLS só pra health-check
  // deste painel); "Conectado" aqui significa "configurado por completo", não "testado contra o
  // banco" — a mesma distinção que já vale pro resto desta função quando não há chamada de rede.
  const bankPaymentProvider = await getSetting('finance.payment_provider', tenant, transaction, 'sandbox');
  if (bankPaymentProvider === 'santander') {
    const [clientId, clientSecret, certPem, keyPem, workspaceId] = await Promise.all([
      getDecryptedSetting('finance.santander_client_id', tenant, transaction, null),
      getDecryptedSetting('finance.santander_client_secret', tenant, transaction, null),
      getDecryptedSetting('finance.santander_cert_pem', tenant, transaction, null),
      getDecryptedSetting('finance.santander_key_pem', tenant, transaction, null),
      getSetting('finance.santander_workspace_id', tenant, transaction, null),
    ]);
    const complete = Boolean(clientId && clientSecret && certPem && keyPem && workspaceId);
    result.bankPayment = { configured: complete, connected: complete, checkedAt };
  } else {
    result.bankPayment = { configured: true, connected: true, checkedAt };
  }

  // Insurance Hub (Marco 7): mesma distinção do Santander acima — nenhuma seguradora foi
  // testada contra credencial real, então "Conectado" aqui significa "configurado por
  // completo", não "testado contra a seguradora".
  const { credentialInVault } = require('../procurement/insurance/insurance.secrets'); // carregado aqui: o módulo de segredos de seguro também lê as configurações
  const insuranceProvider = await getSetting('procurement.insurance_provider', tenant, transaction, 'sandbox');
  if (insuranceProvider === 'porto_seguro') {
    const [clientId, clientSecret] = await Promise.all([
      getDecryptedSetting('procurement.porto_seguro_client_id', tenant, transaction, null),
      getDecryptedSetting('procurement.porto_seguro_client_secret', tenant, transaction, null),
    ]);
    // M9-D238: o segredo do cliente passa para o cofre na primeira operação e sai daqui; a credencial no cofre também conta como configurada.
    const complete = Boolean(clientId && (clientSecret || await credentialInVault(tenant, 'porto_seguro', transaction)));
    result.insurance = { configured: complete, connected: complete, checkedAt };
  } else if (insuranceProvider === 'yelum') {
    const apiKey = (await getDecryptedSetting('procurement.yelum_api_key', tenant, transaction, null)) || (await credentialInVault(tenant, 'yelum', transaction));
    result.insurance = { configured: Boolean(apiKey), connected: Boolean(apiKey), checkedAt };
  } else if (insuranceProvider === 'junto_seguros') {
    // Nunca "configurado" de verdade — não existe credencial real pra essa seguradora ainda
    // (ver nota em InsuranceAdapter.js/resolveInsuranceAdapter.js). Selecionar essa opção no
    // painel cai no Sandbox silenciosamente; aqui refletimos isso como "não configurado".
    result.insurance = { configured: false, connected: false, checkedAt };
  } else {
    result.insurance = { configured: true, connected: true, checkedAt };
  }

  return result;
}

module.exports = {
  SETTINGS_SCHEMA,
  getSetting,
  getDecryptedSetting,
  upsertSetting,
  listSettingsByPrefix,
  getSettingRow,
  getIntegrationsStatus,
};
