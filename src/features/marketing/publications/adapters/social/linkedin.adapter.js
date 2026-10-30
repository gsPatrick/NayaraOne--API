'use strict';

const { socialSandbox, socialReal } = require('./social.adapter');

/** M9-D428 — adapter do LinkedIn: sandbox determinístico (LinkedInAdapter) e adapter real (LinkedInRealAdapter), com as capabilities de networks.js. */
class LinkedInAdapter extends socialSandbox('LINKEDIN') {}
class LinkedInRealAdapter extends socialReal('LINKEDIN') {}

module.exports = { LinkedInAdapter, LinkedInRealAdapter };
