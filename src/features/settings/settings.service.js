'use strict';

const { Op } = require('sequelize');
const { TenantSetting } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { encryptSecret, decryptSecret } = require('../../utils/mfaCrypto');
const { GOVERNANCE_SETTINGS_SCHEMA } = require('../../features/core-governance/governance.settings');
const { runSettingGuard } = require('./settingGuards');
const { AI_SETTINGS_SCHEMA } = require('../../features/ai/ai.settings');
const { MARKETING_SETTINGS_SCHEMA } = require('../../features/marketing/marketing.settings');
const { parseBackoffList } = require('../../engines/events/outboxBackoffParse');
const { PUBLIC_FIELDS_SETTINGS_SCHEMA } = require('../../features/marketing/content/publicFields.settings');
const { TEMPLATE_SETTINGS_SCHEMA } = require('../../features/marketing/content/template.settings');
const { TRACKING_SETTINGS_SCHEMA } = require('../../features/marketing/tracking/tracking.settings');
const { PIPELINE_SETTINGS_SCHEMA } = require('../../features/marketing/content/pipeline.settings');
const { TYPES_SETTINGS_SCHEMA } = require('../../features/marketing/content/types/settings');
const { FACTUAL_SETTINGS_SCHEMA } = require('../../features/marketing/content/factual/settings');
const { CAMPAIGN_SETTINGS_SCHEMA } = require('../../features/marketing/campaigns/campaigns.settings');
const { COST_SETTINGS_SCHEMA } = require('../../features/marketing/campaigns/cost.settings');
const { SEGMENT_SETTINGS_SCHEMA } = require('../../features/marketing/campaigns/segment.settings');
const { CADENCE_SETTINGS_SCHEMA } = require('../../features/marketing/automations/cadence/cadence.settings');
const { SUPPRESSION_SETTINGS_SCHEMA } = require('../../features/marketing/suppression/suppression.settings');
const { CATALOG_SETTINGS_SCHEMA, IntegrationHttpClient } = require('../integrations');
const { SECRET_SETTINGS_SCHEMA } = require('../integrations/secrets/secrets.settings');
const { ERRORS_SETTINGS_SCHEMA } = require('../integrations/errors/errors.settings');
const { HEALTH_SETTINGS_SCHEMA } = require('../integrations/health/health.settings');
const { CIRCUIT_SETTINGS_SCHEMA } = require('../integrations/health/circuit.settings');
const { ALERT_SETTINGS_SCHEMA } = require('../integrations/health/alerts/alerts.settings');
const { SYNC_SETTINGS_SCHEMA } = require('../integrations/sync/sync.settings');
const { INBOX_SETTINGS_SCHEMA } = require('../integrations/inbox/inbox.settings');
const { DISPATCH_SETTINGS_SCHEMA } = require('../integrations/dispatch/dispatch.settings');
const { MINIMIZATION_SETTINGS_SCHEMA } = require('../integrations/minimization/minimization.settings');
const { PUBLICATION_SETTINGS_SCHEMA } = require('../properties/publicReadModel/publicReadModel.settings');
const { ADAPTERS_SETTINGS_SCHEMA } = require('../integrations/registry/adapters.settings');
const { DEPAUDIT_SETTINGS_SCHEMA } = require('../integrations/depaudit/depaudit.settings');
const { TRANSPORT_SETTINGS_SCHEMA } = require('../integrations/http/transport.settings');
const { RETENTION_SETTINGS_SCHEMA } = require('../integrations/retention/retention.settings');
const { READ_ONLY_SETTINGS_SCHEMA } = require('../../features/analytics/readOnly/readOnly.settings');
const { METRICS_SETTINGS_SCHEMA } = require('../../features/analytics/metrics/metrics.settings');
const { READ_MODEL_SETTINGS_SCHEMA } = require('../../features/analytics/read-models/readModel.settings');
const { REBUILD_SETTINGS_SCHEMA } = require('../../features/analytics/read-models/rebuild.settings');
const { SOURCE_REFS_SETTINGS_SCHEMA } = require('../../features/analytics/metrics/sourceRefs.settings');
const { DRILLDOWN_SETTINGS_SCHEMA } = require('../../features/analytics/metrics/drilldown.settings');
const { FINANCE_HEALTH_SETTINGS_SCHEMA } = require('../../features/analytics/read-models/financeHealth.settings');
const { FINANCE_KPI_SETTINGS_SCHEMA } = require('../analytics/read-models/financeKpi.settings');
const { FINANCE_WINDOW_SETTINGS_SCHEMA } = require('../analytics/read-models/financeWindow.settings');
const { CASH_SETTINGS_SCHEMA } = require('../analytics/read-models/cash.settings');
const { CRM_KPI_SETTINGS_SCHEMA } = require('../analytics/read-models/crmKpi.settings');
const { FINANCE_RESULT_SETTINGS_SCHEMA } = require('../analytics/read-models/financeResults.settings');
const { LOAD_SETTINGS_SCHEMA } = require('../analytics/loadTest.settings');
const { COMERCIAL_SETTINGS_SCHEMA } = require('../../features/analytics/read-models/comercial.settings');
const { IMOVEIS_KPI_SETTINGS_SCHEMA } = require('../../features/analytics/read-models/imoveisKpi.settings');
const { LOCACAO_SETTINGS_SCHEMA } = require('../../features/analytics/read-models/locacao.settings');
const { OBRA_SETTINGS_SCHEMA } = require('../../features/analytics/read-models/obra.settings');
const { OBRA_KPI_SETTINGS_SCHEMA } = require('../../features/analytics/read-models/obraKpi.settings');
const { JURIDICO_SETTINGS_SCHEMA } = require('../../features/analytics/read-models/juridico.settings');
const { QUALITY_SETTINGS_SCHEMA } = require('../../features/analytics/quality/quality.settings');
const { CACHE_SETTINGS_SCHEMA } = require('../../features/analytics/security/cache.settings');
const { MV_SETTINGS_SCHEMA } = require('../../features/analytics/read-models/matview.settings');
const { MKT_ATENDIMENTO_SETTINGS_SCHEMA } = require('../../features/analytics/read-models/marketingAtendimento.settings');
const { NAY_TOOLS_SETTINGS_SCHEMA } = require('../../features/analytics/nayToolsSettings');
const { SNAPSHOT_SETTINGS_SCHEMA } = require('../../features/analytics/metrics/snapshots.settings');
const { BI_ALERT_SETTINGS_SCHEMA } = require('../../features/analytics/alerts/engine.settings');
const { SECURITY_SETTINGS_SCHEMA } = require('../../features/analytics/security/security.settings');

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
  // FIN-005 (contrato bruto, Centro Financeiro §2 "Princípios constitucionais": "Limites vêm
  // do Motor de Regras; aprovação usa snapshot/hash.") — o QUANTO (multiplicador/limiar em
  // R$) é ajustável aqui, mas o SE a regra de antifraude está ativa para o tenant continua
  // decidido pelo Motor de Regras (evaluateRule('FIN-005', ...), fail-closed) — mesmo padrão
  // já usado em billing.late_fee_percentage/REG-LOC-001 (collectionCase.service.js).
  'finance.antifraud_history_multiplier': { type: 'number', min: 1 },
  'finance.antifraud_new_account_threshold': { type: 'number', min: 0 },
  // FIN-TS-013 "Conta nova | Pagamento alto imediato | Controle extra" — período de
  // resfriamento (em horas) de conta bancária nova/alterada, mesma regra FIN-005.
  'finance.bank_account_cooldown_hours': { type: 'integer', min: 0 },
  // EST-013 / Guia §12 (NAY Estoque, inventoryNay.service.js): lead time padrão (dias) usado
  // pela sugestão de compra quando o item ainda não tem histórico real de reposição
  // (pedido de compra -> recebimento) para medir o prazo observado.
  'inventory.nay_default_lead_time_days': { type: 'integer', min: 0, max: 365 },
  'billing.late_fee_percentage': { type: 'number', min: 0, max: 100 },
  'billing.interest_percentage': { type: 'number', min: 0, max: 100 },
  'billing.grace_period_days': { type: 'integer', min: 0 },
  'billing.default_index_code': { type: 'string' },
  'mfa.step_up_ttl_minutes': { type: 'integer', min: 1, max: 120 },
  'mfa.required_for_sensitive_roles': { type: 'boolean' },
  'legal.signature_provider': { type: 'string', enum: ['sandbox', 'clicksign', 'zapsign'] },
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
  'procurement.insurance_provider': { type: 'string', enum: ['sandbox', 'porto_seguro', 'junto_seguros', 'yelum'] },
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
  // Marco 9, M9-D409 — tipos de conteúdo: hora do aniversário, casas do percentual, fotos mínimas, tipos com rascunho automático, finalidade do pós-venda e varredura de obras.
  ...TYPES_SETTINGS_SCHEMA,
  // Marco 9, M9-D407 — validador factual: tolerância de área, dicionário de características e telefones da empresa.
  ...FACTUAL_SETTINGS_SCHEMA,
  // Marco 9, M9-D431 - janela da atribuição (first-touch e last-touch) em dias.
  ...TRACKING_SETTINGS_SCHEMA,
  // Marco 9, M9-D200 — registro de integrações (integration.providers/connections). Tudo que o
  // Marco 9, M9-D417 — cadência, quiet hours e frequency cap do Marketing (lidos por getMarketingParam; escrita exige marketing:automation:manage).
  ...CADENCE_SETTINGS_SCHEMA,
  // Marco 9, M9-D418 — listas de finalidade do consentimento, palavras de opt-out e janela de atendimento do canSend.
  ...SUPPRESSION_SETTINGS_SCHEMA,
  // livro deixa em aberto é decidido pelo administrador; o padrão é o valor de _parametros-bloco-B.csv.
  // INT-P091: mudança de conexão em PRODUÇÃO e teste de conexão em produção exigem MFA recente.
  'integration.admin.mfa_on_prod_test_connection': { type: 'boolean' },
  'integration.admin.mfa_on_prod_connection_change': { type: 'boolean' },
  // Tamanho mínimo (caracteres) de texto base64/hex sem espaço tratado como segredo embutido em config_json/policy_json.
  'integration.registry.secret_scan_min_length': { type: 'integer', min: 24, max: 256 },
  // Resolução por domínio quando há mais de uma conexão ACTIVE no mesmo domínio e ambiente.
  'integration.registry.domain_resolution': { type: 'string', enum: ['error_if_multiple', 'oldest_active', 'newest_active'] },
  // M9-D204: esperas (ms) entre as tentativas de publicação interna do outbox; o tamanho da lista é o limite de tentativas.
  'integration.outbox.backoff_ms': {
    type: 'string',
    validate: (key, value) => {
      if (!parseBackoffList(value)) {
        throw AppError.badRequest(`O valor de "${key}" deve ser uma lista de milissegundos inteiros positivos separados por vírgula (ex.: 60000,300000).`, 'SETTING_INVALID_VALUE', { key, value });
      }
    },
  },
  // Marco 9, M9-D201 — criticidade de cada uma das 14 famílias do catálogo (integration.catalog.criticality.<domínio>).
  ...CATALOG_SETTINGS_SCHEMA,
  // Marco 9, M9-D202 — cofre de segredos: cache, janela de graça, idade máxima BANK, avisos, prefixo da empresa e MFA do BANK.
  ...SECRET_SETTINGS_SCHEMA,
  // Marco 9, M9-D207 — erros de integração: janela de agrupamento, retenção e tentativas até a severidade subir.
  ...ERRORS_SETTINGS_SCHEMA,
  // Marco 9, M9-D206 — saúde dos fornecedores: dado velho, janela do job, retenção, falhas até DOWN e meta de SLO por criticidade.
  ...HEALTH_SETTINGS_SCHEMA,
  // Marco 9, M9-D217 — circuit breaker: falhas seguidas até abrir, cooldown, chamadas de teste em HALF_OPEN, sucessos para fechar e espera de quem não coube.
  ...CIRCUIT_SETTINGS_SCHEMA,
  // Marco 9, M9-D224 — alertas das integrações: repetição (antiflap), papéis avisados, minutos de circuito aberto até alertar e intervalo da avaliação.
  ...ALERT_SETTINGS_SCHEMA,
  // Marco 9, M9-D208 — sincronização retomável: página, lease, sobreposição, falhas até parar e limite de sync parado por criticidade.
  ...SYNC_SETTINGS_SCHEMA,
  // Marco 9, M9-D203 — caixa de entrada de webhooks: tentativas, retenção do corpo e da linha, espera entre tentativas, tamanho e cabeçalhos guardados.
  ...INBOX_SETTINGS_SCHEMA,
  // Marco 9, M9-D205 — envios a fornecedores: espera até SENDING virar UNKNOWN, retenção do envio e do conteúdo, tentativas máximas.
  ...DISPATCH_SETTINGS_SCHEMA,
  // Marco 9, M9-D219 — minimização dos dados enviados: classificação máxima por família (só pode ser mais restritiva que o livro).
  ...MINIMIZATION_SETTINGS_SCHEMA,
  // Marco 9, M9-D231 — publicação do site e dos portais: raio da coordenada aproximada (até 300 m).
  ...PUBLICATION_SETTINGS_SCHEMA,
  // Marco 9, M9-D209 — contrato de adapters: tempo do teste de saúde e das chamadas de leitura e escrita ao fornecedor.
  ...ADAPTERS_SETTINGS_SCHEMA,
  // Marco 9, M9-D248 — auditoria de dependências e SDKs: versão exata, lista de SDKs, validade da exceção e hora do job diário.
  ...DEPAUDIT_SETTINGS_SCHEMA,
  // Marco 9, M9-D244 — modo da allowlist de saída (enforce ou log) e hora do job de retenção que chama integration.purge_expired().
  ...TRANSPORT_SETTINGS_SCHEMA,
  ...RETENTION_SETTINGS_SCHEMA,
  // Marco 9, M9-D612 — BI somente leitura: usar o role de banco sem escrita nos GET de /analytics (padrão Ligado).
  ...READ_ONLY_SETTINGS_SCHEMA,
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
  ...FINANCE_WINDOW_SETTINGS_SCHEMA,
  // Marco 9, M9-D630 — KPIs do funil comercial: owner de cada KPI e limites de qualidade (origem vazia e amostra mínima).
  ...CRM_KPI_SETTINGS_SCHEMA,
  ...FINANCE_RESULT_SETTINGS_SCHEMA,
  // Marco 9, M9-D699 — teste de carga do BI: quanto o p95 do fluxo operacional pode subir com os painéis sob carga.
  ...LOAD_SETTINGS_SCHEMA,
  // Marco 9, M9-D616 — read models de Comercial/Imóveis: oportunidade parada, janela de recálculo dos números diários, resposta da NAY e faixas de imóvel sem venda.
  // Marco 9, M9-D620 — KPIs de caixa livre e dinheiro de terceiros: saldo de abertura, termos de origem (caução, repasse), mapa de status do ledger e owners.
  ...CASH_SETTINGS_SCHEMA,
  ...COMERCIAL_SETTINGS_SCHEMA,
  ...IMOVEIS_KPI_SETTINGS_SCHEMA,
  // Marco 9, M9-D617 — read models de Locação: tipos de contrato, prazo do repasse e nota de cada tipo de registro de atendimento (a janela da inadimplência é a da D615).
  ...LOCACAO_SETTINGS_SCHEMA,
  // Marco 9, M9-D618 — read models de Obras e Estoque: método de previsão, status de contrato da receita e tipos de item do estoque.
  ...OBRA_SETTINGS_SCHEMA,
  // Marco 9, M9-D650 — KPIs de Obras no BI (avanço, custo e margem): owner de cada indicador.
  ...OBRA_KPI_SETTINGS_SCHEMA,
  // Marco 9, M9-D619 — read models do Jurídico: status que tiram o processo de "ativo".
  ...JURIDICO_SETTINGS_SCHEMA,
  // Marco 9, M9-D696 — qualidade de dados do BI: faixa de linhas, nulos, tolerância da conciliação, severidades e limites de freshness por domínio.
  ...QUALITY_SETTINGS_SCHEMA,
  // Marco 9, M9-D698 — desempenho do BI: TTL do cache dos painéis (analytics.cache.ttl_segundos) e agenda das materialized views (analytics.mv.schedule).
  ...CACHE_SETTINGS_SCHEMA,
  ...MV_SETTINGS_SCHEMA,
  // Marco 9, M9-D627 — read models de Marketing e Atendimento: dias que a agenda reconfere.
  ...MKT_ATENDIMENTO_SETTINGS_SCHEMA,
  // Marco 9, M9-D695 — ferramentas da NAY Diretoria no BI: tamanho máximo das listas devolvidas.
  ...NAY_TOOLS_SETTINGS_SCHEMA,
  // Marco 9, M9-D609 — snapshot diário do BI: hora de execução (padrão 00:30 de São Paulo) e limite de dias do catch-up.
  ...SNAPSHOT_SETTINGS_SCHEMA,
  // Marco 9, M9-D691 — alert engine: cooldown por severidade, avaliações para resolver, intervalo, owner reserva e os alertas semente.
  ...BI_ALERT_SETTINGS_SCHEMA,
  // Marco 9, M9-D700 / M9-D687 — segurança do BI (mapa de domínio x permissão, equipes, campos extras mascarados, log de abertura, p95 padrão).
  ...SECURITY_SETTINGS_SCHEMA,
  // M9-D002: guardar conversa inteira como memória da NAY (padrão Desligado; o Ligado vale só pela regra única de M9-D009).
  'ia.memoria.guardar_conversa_inteira': { type: 'boolean' },
};

function validateAgainstSchema(key, value) {
  const spec = SETTINGS_SCHEMA[key];
  if (!spec) {
    throw AppError.badRequest(`Chave de configuração desconhecida: "${key}".`, 'SETTING_UNKNOWN_KEY', { key });
  }

  if (spec.type === 'number' || spec.type === 'integer') {
    if (typeof value !== 'number' || Number.isNaN(value)) {
      throw AppError.badRequest(`O valor de "${key}" deve ser numérico.`, 'SETTING_INVALID_VALUE', { key, value });
    }
    if (spec.type === 'integer' && !Number.isInteger(value)) {
      throw AppError.badRequest(`O valor de "${key}" deve ser um número inteiro.`, 'SETTING_INVALID_VALUE', { key, value });
    }
    if (spec.min !== undefined && value < spec.min) {
      throw AppError.badRequest(`O valor de "${key}" deve ser >= ${spec.min}.`, 'SETTING_INVALID_VALUE', { key, value });
    }
    if (spec.max !== undefined && value > spec.max) {
      throw AppError.badRequest(`O valor de "${key}" deve ser <= ${spec.max}.`, 'SETTING_INVALID_VALUE', { key, value });
    }
    return;
  }

  if (spec.type === 'boolean') {
    if (typeof value !== 'boolean') {
      throw AppError.badRequest(`O valor de "${key}" deve ser booleano.`, 'SETTING_INVALID_VALUE', { key, value });
    }
    return;
  }

  if (spec.type === 'string') {
    if (typeof value !== 'string' || value.trim() === '') {
      throw AppError.badRequest(`O valor de "${key}" deve ser uma string não vazia.`, 'SETTING_INVALID_VALUE', { key, value });
    }
    if (Array.isArray(spec.enum) && !spec.enum.includes(value)) {
      throw AppError.badRequest(
        `O valor de "${key}" deve ser um dos seguintes: ${spec.enum.join(', ')}.`,
        'SETTING_INVALID_VALUE',
        { key, value }
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
async function upsertSetting(key, value, tenant, actorUserId, transaction) {
  if (!tenant || !tenant.groupId || !tenant.companyId) {
    throw AppError.badRequest('Contexto de tenant (groupId/companyId) é obrigatório para configurar settings.', 'SETTING_TENANT_REQUIRED');
  }

  validateAgainstSchema(key, value);
  // Trava de gravação do dono da regra (M9-D034): recusa o valor antes de qualquer escrita.
  await runSettingGuard(key, value, tenant, actorUserId, transaction);

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
  // salvas — resolveBankAdapter.js já usa essa mesma lista pra decidir entre o adapter real e o
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
  const insuranceProvider = await getSetting('procurement.insurance_provider', tenant, transaction, 'sandbox');
  if (insuranceProvider === 'porto_seguro') {
    const [clientId, clientSecret] = await Promise.all([
      getDecryptedSetting('procurement.porto_seguro_client_id', tenant, transaction, null),
      getDecryptedSetting('procurement.porto_seguro_client_secret', tenant, transaction, null),
    ]);
    const complete = Boolean(clientId && clientSecret);
    result.insurance = { configured: complete, connected: complete, checkedAt };
  } else if (insuranceProvider === 'yelum') {
    const apiKey = await getDecryptedSetting('procurement.yelum_api_key', tenant, transaction, null);
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
