'use strict';

const networks = require('./networks');
const { InstagramAdapter, InstagramRealAdapter } = require('./instagram.adapter');
const { FacebookAdapter, FacebookRealAdapter } = require('./facebook.adapter');
const { LinkedInAdapter, LinkedInRealAdapter } = require('./linkedin.adapter');
const { YouTubeAdapter, YouTubeRealAdapter } = require('./youtube.adapter');
const { TikTokAdapter, TikTokRealAdapter } = require('./tiktok.adapter');
const capabilities = require('./social.capabilities');
const watermark = require('./social.watermark');
const errors = require('./social.errors');
const settings = require('./social.settings');
const schedule = require('./social.schedule');
const { contentOf } = require('./social.adapter');

/** Adapters de rede social (M9-D428): um por rede, em sandbox e real. */
const SANDBOX_ADAPTERS = Object.freeze({ INSTAGRAM: InstagramAdapter, FACEBOOK: FacebookAdapter, LINKEDIN: LinkedInAdapter, YOUTUBE: YouTubeAdapter, TIKTOK: TikTokAdapter });
const REAL_ADAPTERS = Object.freeze({ INSTAGRAM: InstagramRealAdapter, FACEBOOK: FacebookRealAdapter, LINKEDIN: LinkedInRealAdapter, YOUTUBE: YouTubeRealAdapter, TIKTOK: TikTokRealAdapter });

module.exports = {
  ...networks, SANDBOX_ADAPTERS, REAL_ADAPTERS,
  InstagramAdapter, FacebookAdapter, LinkedInAdapter, YouTubeAdapter, TikTokAdapter, InstagramRealAdapter, FacebookRealAdapter, LinkedInRealAdapter, YouTubeRealAdapter, TikTokRealAdapter,
  checkContentFits: capabilities.checkContentFits, assertContentFits: capabilities.assertContentFits,
  watermarkFor: watermark.watermarkFor, applyWatermark: watermark.applyWatermark, extractWatermarkCode: watermark.extractWatermarkCode,
  normalizeResultError: errors.normalizeResultError, assertSocialResult: errors.assertSocialResult, providerAuthFailed: errors.providerAuthFailed, providerUnavailable: errors.providerUnavailable, capabilityViolation: errors.capabilityViolation,
  SOCIAL_SETTINGS_SCHEMA: settings.SOCIAL_SETTINGS_SCHEMA, SOCIAL_SETTING_DEFAULTS: settings.SOCIAL_SETTING_DEFAULTS, readSocialConfig: settings.readSocialConfig, adapterOptions: settings.adapterOptions, capKey: settings.capKey,
  assertSocialCapabilities: schedule.assertSocialCapabilities, assertNetworkAuthorized: schedule.assertNetworkAuthorized, contentOf,
};
