// "Buy me a coffee" (owner, 2026-10-20; Zcash added 2026-10-21): the maker's shielded NAM address and shielded Zcash
// address, one at a time behind a switch, each with a copy button and a QR code. Loaded only when the footer button is
// pressed; the QR library loads with it (import('qrcode'), as the pairing code does).
import { useEffect, useState } from 'react';
import { SITE } from '../../../shared/site';
import { Button, Segmented, Sheet } from '../ui';

type ToDataURL = (text: string, opts: Record<string, unknown>) => Promise<string>;
type Coin = 'nam' | 'zec';

/** What the sheet says for each coin. The addresses live in shared/site.ts (test/donate-addresses.test.ts decodes both). */
const COINS: Record<Coin, { tab: string; label: string; address: string; from: string }> = {
  nam: {
    tab: 'NAM',
    label: 'Shielded NAM address',
    address: SITE.donateShielded,
    from: 'Send from Namadillo or Namada Keychain. Paying from a shielded account keeps who sent it private.',
  },
  zec: {
    tab: 'Zcash',
    label: 'Shielded Zcash address',
    address: SITE.donateZcash,
    from: 'Send from a Zcash wallet such as Zashi or Ywallet. The money always arrives shielded, and paying from a shielded account also keeps who sent it private.',
  },
};

export default function DonateSheet({ onClose }: { onClose: () => void }) {
  const [coin, setCoin] = useState<Coin>('nam');
  const { label, address, from } = COINS[coin];
  const [qr, setQr] = useState<string | null>(null);
  const [copied, setCopied] = useState<'yes' | 'no' | null>(null);

  useEffect(() => {
    let live = true;
    setQr(null);
    setCopied(null);
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
      lead="NamadaTrade is free, independent and has no ads. If it helps you, you can send any amount of NAM or Zcash to the address below.">
      <div className="sheet__body sh-coffee__body">
        <Segmented label="Coin to send" value={coin} onChange={setCoin} options={(Object.keys(COINS) as Coin[]).map((c) => ({ value: c, label: COINS[c].tab }))} />
        <p className="sh-coffee__k">{label}</p>
        <p className="sh-coffee__addr mono" translate="no">{address}</p>
        <div className="sh-coffee__act">
          <Button variant="primary" icon="copy" onClick={copy}>{copied === 'yes' ? 'Copied' : 'Copy address'}</Button>
          <span className="sh-coffee__msg" role="status" aria-live="polite">
            {copied === 'yes' ? 'The address is on your clipboard.' : copied === 'no' ? 'Copying was blocked; select the address and copy it.' : ''}
          </span>
        </div>
        <div className="sh-coffee__qr">
          {qr ? <img src={qr} width={180} height={180} alt={`QR code of the ${label.charAt(0).toLowerCase()}${label.slice(1)}`} /> : <span className="sh-coffee__qrwait" aria-hidden="true" />}
        </div>
        <p className="sh-coffee__note">
          {from} This is a gift to the person who builds this site: it buys nothing and cannot be sent back.
        </p>
      </div>
    </Sheet>
  );
}
