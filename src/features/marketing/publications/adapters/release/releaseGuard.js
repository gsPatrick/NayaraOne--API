'use strict';

const { registerSettingGuard } = require('../../../../settings/settingGuards');
const { releaseServiceOnly } = require('../channel.errors');
const { insideReleaseService } = require('./releaseScope');

/** Registra a trava de gravação (M9-D034) de cada parâmetro de liberação: fora do serviço de liberação, 403 MKT_CHANNEL_RELEASE_SERVICE_ONLY. */
function registerReleaseGuards(keys) {
  for (const key of keys) {
    registerSettingGuard(key, async () => {
      if (!insideReleaseService()) throw releaseServiceOnly(key);
    });
  }
}

module.exports = { registerReleaseGuards };
