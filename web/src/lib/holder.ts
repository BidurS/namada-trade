// How a holder row is named on every list (Home, Holders, the Address sheet): the plain label the server
// sends (owner decision 6, shared/labels.ts), and a category tag only when it adds information.
import type { Holder } from '../../../shared/types';
import { tagByline } from '../../../shared/labels';

/** The plain name, or null when the address has no label (the row then shows the short address). */
export const holderName = (h: Pick<Holder, 'label_plain'>): string | null => h.label_plain ?? null;

/** A name a signed-in wallet typed (`label_source` 'user'), not a curated label (genesis, foundation, exchange). */
export const isUserTag = (h: Pick<Holder, 'label_source'>): boolean => h.label_source === 'user';

/**
 * A category tag only when it adds information: not "Foundation" next to "Anoma Foundation", not "Validator"
 * next to "… validators" (the name already says it, singular or plural). A user tag never gets a category: it
 * gets its byline ("Tag by tnam1qxyz…"), shown without the ring, so it never reads like a curated name.
 */
export function holderTag(h: Pick<Holder, 'label_plain' | 'category_plain' | 'label_source' | 'label_author'>): string | null {
  if (h.label_source === 'user') return tagByline('user', h.label_author ?? null);
  const cat = h.category_plain ?? null;
  if (!cat) return null;
  const stem = cat.toLowerCase().replace(/s$/, '');
  const name = (h.label_plain ?? '').toLowerCase();
  return stem && name.includes(stem) ? null : cat;
}

/** The raw category a holder filter selects ('none': no label). */
export const holderCatKey = (h: Pick<Holder, 'category'>): string => (h.category ? h.category.toLowerCase() : 'none');
