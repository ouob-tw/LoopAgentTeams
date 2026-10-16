import { markReport } from '../mark.ts';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = ({ request }) => markReport(request, true);
