// What the "Where alerts go" panel says about the saved Discord channel (Settings, DeliveryPanel). Saving a link with
// sending on posts a connection notice to the channel, and sending turns on only once Discord takes it (worker/src/api.ts
// PUT /api/me/settings): a link Discord said is gone (404, Unknown Webhook) or has a wrong token (401, Invalid Webhook
// Token), at that save or to a later alert, keeps the switch off until a new link is saved, since turning the same
// link on again would only be answered the same way; a link the notice did not reach with an answer that blames it (a
// 400, a 429 of user scope: reason 'notice') keeps its switch, which posts the notice again; and a link the notice did
// not reach twice with an answer that says nothing of it (no answer, a 5xx, a 429 that is not the link's own) is saved
// with sending on and a note (`notice`) that the first alert, or a test message, shows whether the link works; when no
// post reaches such a channel within a day, the notice is posted again once a day (`notice.tries`); it is turned off
// when Discord refuses one of those posts or none has reached it after three such days (`stopped` with `savedAt`), and
// keeps its switch. The server says which in `stopped` and `notice` (worker/src/settings.ts publicView). Such a
// channel is not one its owner paused: the page says what was answered and when.
import type { DiscordChannel } from '../../../../shared/types';
import { fmtUtcLong } from '../../lib/format';

export interface DeliveryView {
  /** The state line: no link; sending on; on, with no post yet taken (the connection notice did not reach the channel); paused by the owner; off because Discord said the link is dead; or off because the connection notice did not reach the channel. */
  state: 'none' | 'on' | 'unproven' | 'paused' | 'stopped' | 'notice';
  /** A warning shown above the form when the channel is off by the server's doing; null otherwise. */
  notice: { title: string; text: string } | null;
  /** The sending switch cannot be used (no link, or a link Discord said is dead). */
  switchDisabled: boolean;
  /** The words under the sending switch. */
  switchDescription: string;
}

/** What Discord said of the link, in plain words, by the answer the server recorded. */
const answerWords = (status: number) =>
  status === 401
    ? { title: 'Discord said this channel link no longer works', said: 'that the link’s token is wrong (401)' }
    : { title: 'Discord said this channel link no longer exists', said: 'that the link is gone (404)' };

/** How Discord answered the connection notice, in plain words (`status` 0: it did not answer). */
export const noticeAnswer = (status: number) => (status ? `Discord answered ${status}` : 'Discord did not answer');

/** The words under the sending switch when switching it on posts the connection notice. */
export const SWITCH_POSTS = 'Switching on posts a connection notice to the channel; sending turns on once Discord takes it.';

export function deliveryView(d: DiscordChannel): DeliveryView {
  if (!d.hasUrl) return { state: 'none', notice: null, switchDisabled: true, switchDescription: 'Save a link first.' };
  if (d.enabled && d.notice) {
    const tries = d.notice.tries;
    const again = tries ? ` The notice was posted again ${tries.n === 1 ? 'once' : `${tries.n} times`}, last on ${fmtUtcLong(tries.at)}: ${noticeAnswer(tries.status)}.` : '';
    return {
      state: 'unproven',
      notice: {
        title: 'The connection notice has not reached this channel yet',
        text: `When the link was saved on ${fmtUtcLong(d.notice.at)}, ${noticeAnswer(d.notice.status)}, twice. Sending is on anyway: the first alert, or a test message, shows whether the link works. If Discord refuses that post, sending is turned off. If no post reaches the channel within a day, the notice is posted again, once a day, and sending is turned off only if none has reached it after three days.${again}`,
      },
      switchDisabled: false,
      switchDescription: 'Switch off to pause sending without removing the link.',
    };
  }
  if (d.stopped?.reason === 'notice' && d.stopped.savedAt != null) {
    // A channel saved on with the note above, turned off later: no post reached it. Either Discord refused one, or
    // the notice posted again on as many days as `tries` did not reach it either.
    const why = d.stopped.tries
      ? `the notice was posted again on ${d.stopped.tries} days and did not reach it either (the last time, on ${fmtUtcLong(d.stopped.at)}, ${noticeAnswer(d.stopped.status)})`
      : `on ${fmtUtcLong(d.stopped.at)} Discord answered ${d.stopped.status} to a post to it`;
    return {
      state: 'notice',
      notice: {
        title: 'No post has reached this channel',
        text: `The link was saved on ${fmtUtcLong(d.stopped.savedAt)} while the connection notice could not reach the channel, and ${why}, so sending is off. Switch sending on to post the notice again, or save the link again.`,
      },
      switchDisabled: false,
      switchDescription: SWITCH_POSTS,
    };
  }
  if (d.stopped?.reason === 'notice') {
    return {
      state: 'notice',
      notice: {
        title: 'The connection notice did not reach this channel',
        text: `When the link was saved on ${fmtUtcLong(d.stopped.at)}, ${noticeAnswer(d.stopped.status)}, so sending is off. Switch sending on to post the notice again, or save the link again.`,
      },
      switchDisabled: false,
      switchDescription: SWITCH_POSTS,
    };
  }
  if (d.stopped) {
    const w = answerWords(d.stopped.status);
    return {
      state: 'stopped',
      notice: { title: w.title, text: `Sending is off since ${fmtUtcLong(d.stopped.at)}, when Discord answered ${w.said}. Alerts stay off until a new link is saved.` },
      switchDisabled: true,
      switchDescription: 'Paste a new link from Discord above to turn sending on again.',
    };
  }
  return { state: d.enabled ? 'on' : 'paused', notice: null, switchDisabled: false, switchDescription: d.enabled ? 'Switch off to pause sending without removing the link.' : 'Switch on to send alerts to the saved link again.' };
}

/**
 * What the status line says after a save that was meant to turn sending on: the connection notice was posted and
 * alerts go to the channel, or why sending stays off (thrown by the panel as the save's failure, so the line shows it
 * as one, though the link itself was saved).
 */
export function savedWords(d: DiscordChannel): { ok: true; text: string } | { ok: false; text: string } {
  if (d.enabled && d.notice) return { ok: true, text: `Saved. The connection notice did not reach the channel (${noticeAnswer(d.notice.status)}), but sending is on: the first alert, or a test message, shows whether the link works.` };
  if (d.enabled) return { ok: true, text: 'Saved. A connection notice was posted to the channel, and alerts now go there.' };
  if (d.stopped?.reason === 'notice') return { ok: false, text: `The link was saved, but the connection notice did not reach the channel: ${noticeAnswer(d.stopped.status)}. Sending stays off; switch it on to try again.` };
  if (d.stopped) return { ok: false, text: `The link was saved, but Discord said ${d.stopped.status === 401 ? 'its token is wrong (401)' : 'it no longer exists (404)'}. Sending stays off until a new link is saved.` };
  return { ok: false, text: 'The link was saved with sending off.' };
}
