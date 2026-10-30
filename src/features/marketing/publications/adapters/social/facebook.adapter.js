'use strict';

const { socialSandbox, socialReal } = require('./social.adapter');

/** M9-D428 — adapter do Facebook: sandbox determinístico (FacebookAdapter) e adapter real (FacebookRealAdapter), com as capabilities de networks.js. */
class FacebookAdapter extends socialSandbox('FACEBOOK') {}
class FacebookRealAdapter extends socialReal('FACEBOOK') {}

module.exports = { FacebookAdapter, FacebookRealAdapter };
