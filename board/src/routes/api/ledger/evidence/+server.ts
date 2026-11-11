import { serveEvidence } from '#lib/server/ledger-evidence.ts';
import type { RequestHandler } from './$types';

/** A report file a ledger row names as evidence, read-only (see ledger-evidence.ts). */
export const GET: RequestHandler = ({ url }) => serveEvidence(url.searchParams.get('path'));
