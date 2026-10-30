'use strict';

const { socialSandbox, socialReal } = require('./social.adapter');

/** M9-D428 — adapter do TikTok: sandbox determinístico (TikTokAdapter) e adapter real (TikTokRealAdapter), com as capabilities de networks.js. */
class TikTokAdapter extends socialSandbox('TIKTOK') {}
class TikTokRealAdapter extends socialReal('TIKTOK') {}

module.exports = { TikTokAdapter, TikTokRealAdapter };
