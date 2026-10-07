// Stands in for a notification channel: appends what it was asked to send to AGENT_NOTIFY_TEST_LOG.
import { appendFileSync } from 'node:fs';

const { AGENT_NOTIFY_STATE: state, AGENT_NOTIFY_LABEL: label, AGENT_NOTIFY_BODY: body } = process.env;
appendFileSync(process.env.AGENT_NOTIFY_TEST_LOG, `${state}|${label}|${body}\n`);
