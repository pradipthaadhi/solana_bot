#!/usr/bin/env node
/**
 * Print resolved Stage 6 configuration (secrets redacted). Run: `npm run config:print`
 * @see docs/RUNBOOK_STAGE6.md
 */

import { loadBotEnv, redactBotEnv } from "../config/botEnv.js";

console.log(JSON.stringify(redactBotEnv(loadBotEnv()), null, 2));
