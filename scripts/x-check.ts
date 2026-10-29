// Checks the X keys in the environment against X without posting (GET /2/users/me, signed as sources/x.ts signs a
// post): prints the account's handle, or why the keys were refused, and exits 1 then. Used by scripts/x-connect.sh.
import { oauthHeader } from '../worker/src/sources/x';

const env = { X_API_KEY: process.env.X_API_KEY!, X_API_SECRET: process.env.X_API_SECRET!, X_ACCESS_TOKEN: process.env.X_ACCESS_TOKEN!, X_ACCESS_SECRET: process.env.X_ACCESS_SECRET! };
const url = 'https://api.x.com/2/users/me';
const res = await fetch(url, { headers: { authorization: await oauthHeader(env, 'GET', url) } });
const j = (await res.json().catch(() => ({}))) as any;
if (res.ok && j?.data?.username) {
  console.log(`The keys work: posts will go to @${j.data.username}.`);
} else {
  console.error(`X refused the keys (${res.status}${j?.detail ? `: ${j.detail}` : j?.title ? `: ${j.title}` : ''}). Check them in the developer portal, and that the app has credits.`);
  process.exit(1);
}
