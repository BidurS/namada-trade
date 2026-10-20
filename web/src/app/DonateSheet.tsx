// "Buy me a coffee" (owner, 2026-10-20): the maker's shielded NAM address, a copy button and a QR code. Loaded only
// when the footer button is pressed; the QR library loads with it (import('qrcode'), as the pairing code does).
import { useEffect, useState } from 'react';
import { SITE } from '../../../shared/site';
import { Button, Sheet } from '../ui';

type ToDataURL = (text: string, opts: Record<string, unknown>) => Promise<string>;

export default function DonateSheet({ onClose }: { onClose: () => void }) {
  const address = SITE.donateShielded;
  const [qr, setQr] = useState<string | null>(null);
  const [copied, setCopied] = useState<'yes' | 'no' | null>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      const mod = (await import('qrcode')) as unknown as { toDataURL?: ToDataURL; default?: { toDataURL?: ToDataURL } };
      const toDataURL = mod.toDataURL ?? mod.default?.toDataURL;
      const url = toDataURL ? await toDataURL(address, { margin: 1, width: 360, color: { dark: '#000000', light: '#ffffff' } }) : null;
      if (live) setQr(url);
    })().catch(() => {});
    return () => { live = false; };
  }, [address]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied('yes');
    } catch {
      setCopied('no');
    }
  };

  return (
    <Sheet open onClose={onClose} title="Buy me a coffee" className="sh-coffee"
      lead="NamadaTrade is free, independent and has no ads. If it helps you, you can send any amount of NAM to the address below.">
      <div className="sheet__body sh-coffee__body">
        <p className="sh-coffee__k">Shielded NAM address</p>
        <p className="sh-coffee__addr mono" translate="no">{address}</p>
        <div className="sh-coffee__act">
          <Button variant="primary" icon="copy" onClick={copy}>{copied === 'yes' ? 'Copied' : 'Copy address'}</Button>
          <span className="sh-coffee__msg" role="status" aria-live="polite">
            {copied === 'yes' ? 'The address is on your clipboard.' : copied === 'no' ? 'Copying was blocked; select the address and copy it.' : ''}
          </span>
        </div>
        <div className="sh-coffee__qr">
          {qr ? <img src={qr} width={180} height={180} alt="QR code of the shielded NAM address" /> : <span className="sh-coffee__qrwait" aria-hidden="true" />}
        </div>
        <p className="sh-coffee__note">
          Send from Namadillo or Namada Keychain. Paying from a shielded account keeps who sent it private. This is a gift to the person who
          builds this site: it buys nothing and cannot be sent back.
        </p>
      </div>
    </Sheet>
  );
}
