'use strict';

/** Os ports de domínio (M9-D209): um por família do catálogo, indexados pelo domínio. */
const { MessagingAdapter } = require('../messaging/messaging.port');
const { EmailAdapter } = require('../email/email.port');
const { SiteAdapter } = require('../site/site.port');
const { PortalAdapter } = require('../portal/portal.port');
const { SignatureAdapter } = require('../signature/signature.port');
const { BankAdapter } = require('../bank/bank.port');
const { InsuranceAdapter } = require('../insurance/insurance.port');
const { FinancingProviderAdapter } = require('../financing/financing.port');
const { FiscalAdapter } = require('../fiscal/fiscal.port');
const { SocialAdapter } = require('../social/social.port');
const { StorageAdapter } = require('../storage/storage.port');
const { IdentityAdapter } = require('../identity/identity.port');
const { AiAdapter } = require('../ai/ai.port');
const { AnalyticsAdapter } = require('../analytics/analytics.port');

const PORTS = Object.freeze({
  MESSAGING: MessagingAdapter, EMAIL: EmailAdapter, SITE: SiteAdapter, PORTAL: PortalAdapter, SIGNATURE: SignatureAdapter,
  BANK: BankAdapter, INSURANCE: InsuranceAdapter, FINANCING: FinancingProviderAdapter, FISCAL: FiscalAdapter, SOCIAL: SocialAdapter,
  STORAGE: StorageAdapter, IDENTITY: IdentityAdapter, AI: AiAdapter, ANALYTICS: AnalyticsAdapter,
});

module.exports = { PORTS };
