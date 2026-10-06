import QRCode from 'qrcode-svg';

/** Pure server-side SVG. The QR content is exactly the signed token. */
export function renderTicketQrSvg(token: string): string {
  return new QRCode({
    content: token,
    padding: 4,
    width: 512,
    height: 512,
    ecl: 'M',
    color: '#000000',
    background: '#ffffff',
    join: true,
    pretty: false,
  }).svg();
}
