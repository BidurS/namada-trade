// /openapi.json: the public read API as an OpenAPI 3.1 document, made from the one list the API page is drawn from
// (shared/api-catalog.ts), so the page and this document cannot differ. Each route is a GET; its parameters carry
// the kind, the allowed values and the bounds the catalog states; its answer is an object whose top-level fields
// are named with what each holds. The types behind the fields are in the public repository (shared/types.ts,
// shared/depth.ts): this document names the fields, it does not restate every nested shape.
import { API_CATALOG, API_GROUPS, type ApiEndpoint, type ApiParam } from '../../shared/api-catalog';
import { SITE } from '../../shared/site';
import { PLATFORM_TEXT_CHECKED } from '../../shared/routes';

type Schema = Record<string, unknown>;

/** A parameter's value as a JSON Schema. */
export function paramSchema(p: ApiParam): Schema {
  const bounds = (key: 'minimum' | 'minLength', keyMax: 'maximum' | 'maxLength'): Schema => ({
    ...(p.min != null ? { [key]: p.min } : {}),
    ...(p.max != null ? { [keyMax]: p.max } : {}),
  });
  switch (p.type) {
    case 'whole': return { type: 'integer', ...bounds('minimum', 'maximum') };
    case 'number': return { type: 'number', ...bounds('minimum', 'maximum') };
    case 'time': return { type: 'integer', description: 'A time in unix milliseconds.' };
    case 'day': return { type: 'string', format: 'date' };
    case 'when': return { oneOf: [{ type: 'integer', description: 'A time in unix milliseconds.' }, { type: 'string', format: 'date', description: 'A UTC day.' }] };
    case 'choice': return { type: 'string', enum: [...(p.values ?? [])] };
    case 'address': return { type: 'string', pattern: '^(tnam1|osmo1)[02-9ac-hj-np-z]+$' };
    default: return { type: 'string', ...bounds('minLength', 'maxLength') };
  }
}

const parameter = (p: ApiParam, where: 'query' | 'path'): Schema => ({
  name: p.name,
  in: where,
  required: where === 'path' ? true : !!p.required,
  description: p.fallback != null ? `${p.what} Left out: ${p.fallback}.` : p.what,
  schema: paramSchema(p),
});

/** The refusal every route answers a bad request with (shared/types.ts NotServedBody, and the limiter's own body). */
const REFUSAL: Schema = {
  type: 'object',
  properties: { error: { type: 'string', description: 'Why the request was refused, in plain words.' } },
  required: ['error'],
};

/** Does the route refuse a value (answer 400)? It does when a parameter must be sent, or its words say a value is refused. */
export const refuses = (e: ApiEndpoint): boolean => !!e.pathParam || e.params.some((p) => !!p.required || /\brefused\b/.test(p.what));

function operation(e: ApiEndpoint): Schema {
  const ok = e.csv
    ? { description: 'A file of rows: CSV, or the same rows as JSON when the format parameter asks for it.', content: { 'text/csv': { schema: { type: 'string' } }, 'application/json': { schema: { type: 'object' } } } }
    : {
        description: e.what,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: Object.fromEntries(Object.entries(e.fields).map(([name, what]) => [name, { description: what }])),
            },
          },
        },
      };
  return {
    summary: e.title,
    description: e.what,
    tags: [API_GROUPS.find((g) => g.id === e.group)?.title ?? e.group],
    parameters: [...(e.pathParam ? [parameter(e.pathParam, 'path')] : []), ...e.params.map((p) => parameter(p, 'query'))],
    responses: {
      '200': ok,
      ...(refuses(e) ? { '400': { description: 'A value outside what a parameter takes.', content: { 'application/json': { schema: REFUSAL } } } } : {}),
      ...(e.notFound ? { '404': { description: e.notFound, content: { 'application/json': { schema: REFUSAL } } } } : {}),
      '429': { description: 'Too many requests of this kind from one address; the Retry-After header says how many seconds to wait.', content: { 'application/json': { schema: REFUSAL } } },
      // the health route answers with this status, and the same fields, while a reading has not completed or an incident is open
      ...(e.path === '/api/health' ? { '503': { description: 'Not ok: the same fields as the 200 answer.', content: { 'application/json': { schema: { type: 'object' } } } } } : {}),
    },
  };
}

/** The document, as an object (the test reads it; openApiJson answers it). */
export function openApiDoc(): Schema {
  return {
    openapi: '3.1.0',
    info: {
      title: `${SITE.name} public API`,
      version: PLATFORM_TEXT_CHECKED,
      description: `${SITE.description} ${SITE.disclaimer} Every route is read-only and needs no key. The reference in plain words: ${SITE.origin}/developers`,
      license: { name: 'MIT', identifier: 'MIT' },
    },
    servers: [{ url: SITE.origin }],
    externalDocs: { description: 'The API page', url: `${SITE.origin}/developers` },
    tags: API_GROUPS.map((g) => ({ name: g.title, description: g.lead })),
    paths: Object.fromEntries(API_CATALOG.map((e) => [e.path, { get: operation(e) }])),
  };
}

export function openApiJson(): Response {
  return new Response(JSON.stringify(openApiDoc(), null, 1), {
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=3600', 'access-control-allow-origin': '*', 'x-robots-tag': 'noindex' },
  });
}
