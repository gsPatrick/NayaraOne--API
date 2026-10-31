#!/bin/bash
cd /Users/patrick.developer/Desktop/Developer/Projects/Nayara/NayaraOne/NayaraOne--API
export LOG_LEVEL=error CI_TENANT_USERS_PASSWORD=ci-tenant-users-password-not-for-production CLAMAV_HOST=127.0.0.1 CLAMAV_PORT=3310
node scripts/seed-ci-two-tenants.js >/dev/null || exit 1
exec node "$@"
