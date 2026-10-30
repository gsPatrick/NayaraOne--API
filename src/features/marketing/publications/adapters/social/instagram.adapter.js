'use strict';

const { socialSandbox, socialReal } = require('./social.adapter');

/** M9-D428 — adapter do Instagram: sandbox determinístico (InstagramAdapter) e adapter real (InstagramRealAdapter), com as capabilities de networks.js. */
class InstagramAdapter extends socialSandbox('INSTAGRAM') {}
class InstagramRealAdapter extends socialReal('INSTAGRAM') {}

module.exports = { InstagramAdapter, InstagramRealAdapter };
