/** Server-only AMPED-08B ticket credential codec. No ticket/order data in QR. */
const VERSION = 'AUP1';
const OPAQUE_ID = /^[A-Za-z0-9_-]{43}$/;
const MAC = /^[A-Za-z0-9_-]{43}$/;
const encoder = new TextEncoder();

export type TokenVerification =
  | { outcome: 'valid'; credentialId: string }
  | { outcome: 'malformed' | 'unsupported_version' | 'invalid_signature' };

function encode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function decode(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const binary = atob(value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return encode(bytes) === value ? bytes : null;
  } catch {
    return null;
  }
}

export function newCredentialId(): string {
  return encode(crypto.getRandomValues(new Uint8Array(32)));
}

export interface TicketTokenService {
  sign(credentialId: string): Promise<string>;
  verify(token: string): Promise<TokenVerification>;
}

/** Secret is a canonical base64url encoding of 32 independent random bytes. */
export function createTicketTokenService(secret: string | undefined): TicketTokenService {
  if (!secret || !OPAQUE_ID.test(secret)) throw new Error('TICKET_TOKEN_SECRET is missing or weak.');
  const secretBytes = decode(secret);
  if (!secretBytes || secretBytes.length !== 32) throw new Error('TICKET_TOKEN_SECRET is malformed.');
  const key = crypto.subtle.importKey('raw', Uint8Array.from(secretBytes).buffer, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);

  return {
    async sign(credentialId) {
      if (!OPAQUE_ID.test(credentialId) || decode(credentialId)?.length !== 32) {
        throw new Error('Invalid ticket credential identity.');
      }
      const signature = await crypto.subtle.sign('HMAC', await key, encoder.encode(`ampedup-ticket:v1:${credentialId}`));
      return `${VERSION}.${credentialId}.${encode(new Uint8Array(signature))}`;
    },
    async verify(token) {
      if (typeof token !== 'string' || token.length > 160) return { outcome: 'malformed' };
      const parts = token.split('.');
      if (parts.length !== 3 || parts.some((part) => !part)) return { outcome: 'malformed' };
      if (parts[0] !== VERSION) return { outcome: 'unsupported_version' };
      const credentialId = parts[1]!;
      const signature = parts[2]!;
      if (!OPAQUE_ID.test(credentialId) || !MAC.test(signature)) return { outcome: 'malformed' };
      if (decode(credentialId)?.length !== 32) return { outcome: 'malformed' };
      const signatureBytes = decode(signature);
      if (!signatureBytes || signatureBytes.length !== 32) return { outcome: 'malformed' };
      const valid = await crypto.subtle.verify(
        'HMAC', await key, Uint8Array.from(signatureBytes).buffer, encoder.encode(`ampedup-ticket:v1:${credentialId}`),
      );
      return valid ? { outcome: 'valid', credentialId } : { outcome: 'invalid_signature' };
    },
  };
}
