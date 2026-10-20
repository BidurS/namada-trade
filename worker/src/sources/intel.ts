import type {
  ForumPost,
  ForumTopic,
  GovernanceProposal,
  IntelResponse,
  ValidatorSummary,
} from '../../../shared/types';
import { fetchJson } from '../util';
import { safeHttpUrl } from '../../../shared/flow-rules';

const FORUM_BASE = 'https://forum.namada.net';
const INDEXER_BASE = 'https://indexer.namada.net/api/v1';

const FORUM_CATEGORIES: Record<number, string> = {
  4: 'General',
  5: 'RPGF & Funding Ops',
  11: 'Ecosystem & Strategy',
  12: 'Network / Mainnet Ops',
  15: 'User Support',
  16: 'Archive',
  19: 'Research & Technical',
  21: 'Governance Ops',
  22: 'Mission & Vision',
  35: 'Shielded Microgrants',
  36: 'Delegation Initiative',
};

function cleanExcerpt(rawOrCooked: string | undefined | null, maxLen = 240): string {
  if (!rawOrCooked) return '';
  const stripped = rawOrCooked
    .replace(/!\[[^\]]*\]\([^)]+\)/g, '[Image]')
    .replace(/<[^>]+>/g, ' ')
    .replace(/https?:\/\/\S+/g, (u) => (u.length > 48 ? u.slice(0, 45) + '…' : u))
    .replace(/\s+/g, ' ')
    .trim();
  return stripped.length > maxLen ? stripped.slice(0, maxLen - 1) + '…' : stripped;
}

/**
 * Fetch active PoS bonded and unbonding delegations for a Namada address
 */
/**
 * Fetch latest topics and posts from Namada Discourse Forum (https://forum.namada.net)
 */
export async function fetchForumData(): Promise<{
  topics: ForumTopic[];
  latestPosts: ForumPost[];
}> {
  const [latestRes, postsRes] = await Promise.all([
    fetchJson<any>(`${FORUM_BASE}/latest.json`, { timeoutMs: 7000 }).catch(() => null),
    fetchJson<any>(`${FORUM_BASE}/posts.json`, { timeoutMs: 7000 }).catch(() => null),
  ]);

  const rawTopics: any[] = latestRes?.topic_list?.topics || [];
  const topics: ForumTopic[] = rawTopics
    .filter((t) => t.visible !== false && t.id !== 7) // filter generic welcome boilerplate
    .map((t) => ({
      id: Number(t.id),
      title: String(t.title || 'Untitled Topic'),
      slug: String(t.slug || 'topic'),
      url: `${FORUM_BASE}/t/${t.slug}/${t.id}`,
      categoryId: Number(t.category_id || 4),
      categoryName: FORUM_CATEGORIES[Number(t.category_id)] || 'Community',
      postsCount: Number(t.posts_count || 1),
      replyCount: Number(t.reply_count || 0),
      views: Number(t.views || 0),
      likeCount: Number(t.like_count || 0),
      createdAt: t.created_at || new Date().toISOString(),
      lastPostedAt: t.last_posted_at || t.created_at || new Date().toISOString(),
      lastPoster: String(t.last_poster_username || 'namada'),
      pinned: Boolean(t.pinned),
    }))
    .sort((a, b) => new Date(b.lastPostedAt).getTime() - new Date(a.lastPostedAt).getTime())
    .slice(0, 25);

  const rawPosts: any[] = postsRes?.latest_posts || [];
  const latestPosts: ForumPost[] = rawPosts.slice(0, 25).map((p) => {
    const avatarTpl = p.avatar_template ? String(p.avatar_template).replace('{size}', '64') : null;
    const avatarUrl = avatarTpl
      ? avatarTpl.startsWith('http')
        ? avatarTpl
        : `${FORUM_BASE}${avatarTpl}`
      : null;

    return {
      id: Number(p.id),
      topicId: Number(p.topic_id),
      topicTitle: String(p.topic_title || p.topic_slug || 'Discussion'),
      topicSlug: String(p.topic_slug || 'topic'),
      postNumber: Number(p.post_number || 1),
      url: `${FORUM_BASE}/t/${p.topic_slug}/${p.topic_id}/${p.post_number || 1}`,
      username: String(p.username || 'anonymous'),
      displayName: p.name ? String(p.name) : null,
      avatarUrl,
      createdAt: p.created_at || new Date().toISOString(),
      excerpt: cleanExcerpt(p.raw || p.cooked),
      isNewTopic: Number(p.post_number) === 1,
    };
  });

  return { topics, latestPosts };
}

/**
 * Fetch Namada On-Chain Governance Proposals & Consensus Validators
 */
export async function fetchGovernanceAndValidators(): Promise<{
  proposals: GovernanceProposal[];
  validators: ValidatorSummary[];
  indexerEpoch: number | null;
}> {
  const [govRes, valPage1, valPage2, epochRes] = await Promise.all([
    fetchJson<any>(`${INDEXER_BASE}/gov/proposal?page=1`, { timeoutMs: 7000 }).catch(() => null),
    fetchJson<any>(`${INDEXER_BASE}/pos/validator?state=consensus&page=1`, { timeoutMs: 7000 }).catch(
      () => null,
    ),
    fetchJson<any>(`${INDEXER_BASE}/pos/validator?state=consensus&page=2`, { timeoutMs: 7000 }).catch(
      () => null,
    ),
    fetchJson<any>(`${INDEXER_BASE}/chain/epoch/latest`, { timeoutMs: 5000 }).catch(() => null),
  ]);

  const proposals: GovernanceProposal[] = (govRes?.results || []).slice(0, 20).map((p: any) => {
    let content: Record<string, any> = {};
    try {
      content = typeof p.content === 'string' ? JSON.parse(p.content) : p.content || {};
    } catch {}

    const rawTitle = content.title || content.abstract || `Namada Proposal #${p.id}`;
    return {
      id: Number(p.id),
      title: String(rawTitle),
      authors: content.authors ? String(content.authors) : null,
      abstract: cleanExcerpt(content.abstract || content.details || '', 220) || null,
      type: String(p.type || 'default'),
      status: String(p.status || 'unknown'),
      startEpoch: Number(p.startEpoch || 0),
      endEpoch: Number(p.endEpoch || 0),
      activationEpoch: Number(p.activationEpoch || 0),
      yayNam: Number(p.yayVotes || 0),
      nayNam: Number(p.nayVotes || 0),
      abstainNam: Number(p.abstainVotes || 0),
      // On-chain text anyone who submits a proposal controls: only an http(s) link is kept (never javascript: or data:).
      discussionsUrl: safeHttpUrl(content['discussions-to']),
    };
  });

  const allVals = [...(valPage1?.results || []), ...(valPage2?.results || [])];
  const seenVals = new Set<string>();
  const validators: ValidatorSummary[] = [];

  for (const v of allVals) {
    if (!v.address || seenVals.has(v.address)) continue;
    seenVals.add(v.address);
    validators.push({
      address: String(v.address),
      name: v.name ? String(v.name) : null,
      votingPowerNam: Number(v.votingPower || 0),
      commission: Number(v.commission || 0),
      state: String(v.state || 'consensus'),
      avatar: v.avatar ? String(v.avatar) : null,
    });
  }
  validators.sort((a, b) => b.votingPowerNam - a.votingPowerNam);

  const indexerEpoch = epochRes?.epoch ? Number(epochRes.epoch) : null;

  return {
    proposals,
    validators: validators.slice(0, 25),
    indexerEpoch,
  };
}

export async function fetchIntel(): Promise<IntelResponse> {
  const [forum, onchain] = await Promise.all([
    fetchForumData(),
    fetchGovernanceAndValidators(),
  ]);

  return {
    topics: forum.topics,
    latestPosts: forum.latestPosts,
    proposals: onchain.proposals,
    validators: onchain.validators,
    indexerEpoch: onchain.indexerEpoch,
    fetchedAt: Date.now(),
  };
}
