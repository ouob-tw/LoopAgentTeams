// Runs in the built server before anything else is loaded (SvelteKit's server instrumentation), so
// the connection guard sits in front of every request adapter-node answers. See connection-guard.ts.
import { connectionSettings } from '#lib/server/client-address.ts';
import { guardServers } from '#lib/server/connection-guard.ts';

guardServers(connectionSettings(process.env));
