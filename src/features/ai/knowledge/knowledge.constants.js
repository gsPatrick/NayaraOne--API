'use strict';

/** Constantes do conhecimento homologado (M9-D008). */
const STATUSES = Object.freeze(['DRAFT', 'HOMOLOGATED', 'REVOKED', 'SUPERSEDED', 'EXPIRED']);
const CLASSIFICATIONS = Object.freeze(['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED']);
const FACT_KEY_RE = /^[a-z][a-z0-9_.:-]{2,127}$/;
const SUBJECT_TYPE_RE = /^[a-z][a-z0-9_.-]{1,63}$/;

module.exports = { STATUSES, CLASSIFICATIONS, FACT_KEY_RE, SUBJECT_TYPE_RE };
