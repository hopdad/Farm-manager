/**
 * John Deere Operations Center shapes (zod), shared by the live client (./client.ts, ./oauth.ts)
 * and the vendor stand-in (src/sim/vendors/deere), so the same schemas validate real and
 * simulated responses (plan §5).
 *
 * What is confirmed vs doc-derived (developer.deere.com was not reachable from the build
 * machine on Oct 29, 2026; everything marked `doc-derived, confirm` must be checked against
 * the Equipment / Machine Locations docs at 1f and is listed on /admin/connectors):
 *  - OAuth 2 authorization-code flow on signin.johndeere.com (Okta): `/v1/authorize`,
 *    `/v1/token`, client credentials in HTTP Basic, `offline_access` scope for refresh tokens,
 *    RFC 6749 token and error bodies. // doc-derived, confirm (issuer path, scopes)
 *  - API root `https://sandboxapi.deere.com/platform` (sandbox) and
 *    `https://partnerapi.deere.com/platform` (production), media type
 *    `application/vnd.deere.axiom.v3+json`, collections `{ links, total, values }` with
 *    `nextPage` links. // doc-derived, confirm
 *  - Machine breadcrumbs `GET /machines/{id}/breadcrumbs?startDate=&endDate=` recorded only while
 *    the machine is working (plan §5). // doc-derived, confirm (path, field names, units)
 * Objects are `loose`: extra vendor fields never fail a response.
 */
import { z } from 'zod';

/** The Deere API media type (Accept header). */
export const DEERE_MEDIA_TYPE = 'application/vnd.deere.axiom.v3+json';

/** Okta authorization-server id in Deere's sign-in URLs. // doc-derived, confirm */
export const DEERE_AUTH_SERVER_ID = 'aus78tnlaysMraFhC1t7';

/**
 * Scopes requested at consent. `offline_access` returns a refresh token; `eq1` reads equipment,
 * `org1` organizations, `ag1` fields/operations (1f). // doc-derived, confirm
 */
export const DEERE_SCOPES = ['openid', 'profile', 'offline_access', 'ag1', 'eq1', 'org1'] as const;

const time = z.iso.datetime({ offset: true });

export const deereLinkSchema = z.looseObject({ rel: z.string(), uri: z.string() });
export type DeereLink = z.infer<typeof deereLinkSchema>;

/** A Deere collection page: `{ links, total, values }`; the next page is the `nextPage` link. */
export function deereCollectionSchema<T extends z.ZodType>(item: T) {
  return z.looseObject({
    links: z.array(deereLinkSchema).default([]),
    total: z.number().int().nonnegative().optional(),
    values: z.array(item),
  });
}

export const deereOrganizationSchema = z.looseObject({
  '@type': z.literal('Organization').optional(),
  id: z.string().min(1),
  name: z.string(),
  type: z.string().optional(),
  member: z.boolean().optional(),
  links: z.array(deereLinkSchema).optional(),
});
export type DeereOrganization = z.infer<typeof deereOrganizationSchema>;
export const deereOrganizationsSchema = deereCollectionSchema(deereOrganizationSchema);

/** A machine in an org. // doc-derived, confirm (Equipment API field names) */
export const deereMachineSchema = z.looseObject({
  '@type': z.literal('Machine').optional(),
  id: z.string().min(1),
  name: z.string().optional(),
  vin: z.string().optional(),
  modelYear: z.number().int().optional(),
  links: z.array(deereLinkSchema).optional(),
});
export type DeereMachine = z.infer<typeof deereMachineSchema>;
export const deereMachinesSchema = deereCollectionSchema(deereMachineSchema);

const measurement = z.looseObject({ value: z.number(), unit: z.string() });

/** One breadcrumb (recorded only while working). // doc-derived, confirm */
export const deereBreadcrumbSchema = z.looseObject({
  '@type': z.literal('Breadcrumb').optional(),
  point: z.looseObject({
    lat: z.number().min(-90).max(90),
    lon: z.number().min(-180).max(180),
  }),
  eventTimestamp: time,
  /** Ground speed; unit 'km/hr' or 'mph'. */
  speed: measurement.optional(),
  /** Heading; unit 'deg'. */
  heading: measurement.optional(),
  /** e.g. 'Working'. */
  machineState: z.string().optional(),
});
export type DeereBreadcrumb = z.infer<typeof deereBreadcrumbSchema>;
export const deereBreadcrumbsSchema = deereCollectionSchema(deereBreadcrumbSchema);

/** API error body. // doc-derived, confirm */
export const deereApiErrorSchema = z.looseObject({
  errors: z.array(z.looseObject({ message: z.string(), guid: z.string().optional() })),
});

/** RFC 6749 §5.1 token response (authorization_code and refresh_token grants). */
export const deereTokenResponseSchema = z.looseObject({
  access_token: z.string().min(1),
  token_type: z.string(),
  /** Access-token lifetime in seconds. */
  expires_in: z.number().positive(),
  /** Present with offline_access. Deere's real tokens rotate like the stand-in's do. */
  refresh_token: z.string().min(1).optional(),
  scope: z.string().optional(),
});
export type DeereTokenResponse = z.infer<typeof deereTokenResponseSchema>;

/** RFC 6749 §5.2 error response. */
export const oauthErrorSchema = z.looseObject({
  error: z.string(),
  error_description: z.string().optional(),
});
export type OAuthErrorBody = z.infer<typeof oauthErrorSchema>;

/**
 * Raw item landed in ingest.raw_events (stream 'locations'): ONE breadcrumb with the org and
 * machine it was read from. externalId `${orgId}:${machineId}:${eventTimestamp}`.
 */
export const deereBreadcrumbRawSchema = z.object({
  orgId: z.string().min(1),
  machineId: z.string().min(1),
  breadcrumb: deereBreadcrumbSchema,
});
export type DeereBreadcrumbRaw = z.infer<typeof deereBreadcrumbRawSchema>;
