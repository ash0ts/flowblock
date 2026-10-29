import { auth } from '@/auth';
import { createHash } from 'node:crypto';
export class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }
export function isLocal(request?: Request) {
  if (process.env.FLOWBLOCK_LOCAL_MODE !== '1') return false;
  return !request || ['localhost','127.0.0.1','[::1]'].includes(new URL(request.url).hostname);
}
export async function owner(request: Request) {
  if (isLocal(request)) return 'local-developer';
  const session = await auth();
  if (!session?.user?.id) throw new HttpError(401, 'Sign in to save, generate, or analyze. Local planning works without an account.');
  return createHash('sha256').update(session.user.id).digest('hex');
}
export function sameOrigin(request: Request) {
  if (isLocal(request) && request.headers.get('sec-fetch-site') === 'cross-site') throw new HttpError(403, 'Cross-site access to local data is not allowed.');
  if (['GET','HEAD','OPTIONS'].includes(request.method)) return;
  const origin = request.headers.get('origin');
  if (!origin) { if (isLocal(request)) return; throw new HttpError(403,'An Origin header is required.'); }
  const expected = new URL(process.env.APP_URL || request.url).origin;
  if (origin !== expected && !(isLocal(request) && ['http://localhost:3037','http://127.0.0.1:3037'].includes(origin))) throw new HttpError(403,'Cross-origin writes are not allowed.');
}
export async function jsonBody(request: Request) {
  if (request.headers.get('content-type')?.split(';',1)[0].trim().toLowerCase() !== 'application/json') throw new HttpError(415,'Expected application/json.');
  const reader = request.body?.getReader();
  if (!reader) return {};
  const chunks: Uint8Array[]=[]; let length=0;
  while(true) { const item=await reader.read(); if(item.done)break; length+=item.value.byteLength; if(length>2*1024*1024){await reader.cancel();throw new HttpError(413,'Request exceeds 2 MB.');} chunks.push(item.value); }
  try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { throw new HttpError(400,'Invalid JSON.'); }
}
