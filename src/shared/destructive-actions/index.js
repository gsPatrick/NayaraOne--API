'use strict';

module.exports = {
  inventory: require('./inventory'),
  levels: require('./levels'),
  shape: require('./impact.shape'),
  token: require('./impact.token'),
  input: require('./confirmation.input'),
  errors: require('./confirmation.errors'),
  registry: require('./registry'),
  ...require('./guard'),
  ...require('./impact.handler'),
};
