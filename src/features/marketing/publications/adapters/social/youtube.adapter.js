'use strict';

const { socialSandbox, socialReal } = require('./social.adapter');

/** M9-D428 — adapter do YouTube: sandbox determinístico (YouTubeAdapter) e adapter real (YouTubeRealAdapter), com as capabilities de networks.js. */
class YouTubeAdapter extends socialSandbox('YOUTUBE') {}
class YouTubeRealAdapter extends socialReal('YOUTUBE') {}

module.exports = { YouTubeAdapter, YouTubeRealAdapter };
