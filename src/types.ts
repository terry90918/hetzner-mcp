// Hetzner Cloud API Type Definitions

import { z } from "zod";

// Response format enum
export enum ResponseFormat {
  MARKDOWN = "markdown",
  JSON = "json"
}
export const ResponseFormatSchema = z.nativeEnum(ResponseFormat).default(ResponseFormat.MARKDOWN);

// Utility: keys of T whose value type is exactly `boolean`. Used to constrain
// arrays like STORAGE_BOX_PROTOCOLS so a typo (e.g. "name") fails typecheck.
//
// NOTE: This excludes nullable booleans (`boolean | null`) by design — the
// runtime check `obj[key] === true` only makes sense for non-nullable booleans.
// If a schema field becomes `z.boolean().nullable()`, it will silently fall
// out of the protocol list. Keep boolean fields non-nullable in schemas, or
// widen this constraint to `T[K] extends boolean | null` if nulls are needed.
export type BooleanKeys<T> = {
  [K in keyof T]-?: T[K] extends boolean ? K : never;
}[keyof T];

// =====================================================================
// Cloud API — Zod schemas at the boundary (C-2 from /review-pr round 3).
// Same rationale as the Storage Box schemas: makeApiRequest validates
// every response with .parse(), so unexpected API shapes throw ZodError
// instead of silently coercing to undefined downstream.
// =====================================================================

export const HetznerActionSchema = z.object({
  id: z.number(),
  command: z.string(),
  status: z.enum(["running", "success", "error"]),
  progress: z.number(),
  started: z.string(),
  finished: z.string().nullable(),
  error: z.object({
    code: z.string(),
    message: z.string()
  }).nullable()
});
export type HetznerAction = z.infer<typeof HetznerActionSchema>;

export const HetznerServerSchema = z.object({
  id: z.number(),
  name: z.string(),
  status: z.enum([
    "running",
    "initializing",
    "starting",
    "stopping",
    "off",
    "deleting",
    "rebuilding",
    "migrating",
    "unknown"
  ]),
  public_net: z.object({
    ipv4: z.object({ ip: z.string() }).nullable(),
    ipv6: z.object({ ip: z.string() }).nullable()
  }),
  server_type: z.object({
    id: z.number(),
    name: z.string(),
    description: z.string(),
    cores: z.number(),
    memory: z.number(),
    disk: z.number()
  }),
  // Hetzner removed the `datacenter` property from the Servers API on 2026-06-30
  // (announced 2025-12-16, "Phasing out Datacenters in favor of Locations").
  // https://docs.hetzner.cloud/changelog#2025-12-16-phasing-out-datacenters
  //
  // Only the fields formatServer() actually renders are declared. z.object already
  // strips unknown keys, so listing fewer fields is strictly more tolerant of the
  // next upstream change — a required field we never read is a crash waiting to
  // happen (that is exactly how the datacenter removal broke every server tool).
  location: z.object({
    name: z.string(),
    country: z.string(),
    city: z.string()
  }),
  image: z.object({
    id: z.number(),
    name: z.string(),
    description: z.string(),
    os_flavor: z.string(),
    os_version: z.string()
  }).nullable(),
  labels: z.record(z.string(), z.string()),
  created: z.string()
});
export type HetznerServer = z.infer<typeof HetznerServerSchema>;

export const HetznerServerTypeSchema = z.object({
  id: z.number(),
  name: z.string(),
  description: z.string(),
  cores: z.number(),
  memory: z.number(),
  disk: z.number(),
  prices: z.array(z.object({
    location: z.string(),
    price_hourly: z.object({ net: z.string(), gross: z.string() }),
    price_monthly: z.object({ net: z.string(), gross: z.string() })
  })),
  architecture: z.string(),
  cpu_type: z.string()
});

export const HetznerImageSchema = z.object({
  id: z.number(),
  name: z.string(),
  description: z.string(),
  os_flavor: z.string(),
  os_version: z.string(),
  type: z.enum(["system", "snapshot", "backup", "app"]),
  status: z.enum(["available", "creating", "unavailable"]),
  architecture: z.string()
});
export type HetznerImage = z.infer<typeof HetznerImageSchema>;

export const HetznerLocationSchema = z.object({
  id: z.number(),
  name: z.string(),
  description: z.string(),
  country: z.string(),
  city: z.string(),
  latitude: z.number(),
  longitude: z.number(),
  network_zone: z.string()
});

export const HetznerSSHKeySchema = z.object({
  id: z.number(),
  name: z.string(),
  fingerprint: z.string(),
  public_key: z.string(),
  labels: z.record(z.string(), z.string()),
  created: z.string()
});
export type HetznerSSHKey = z.infer<typeof HetznerSSHKeySchema>;

// Pagination meta envelope for Cloud API list responses (mirrors unified API).
// Only next_page is consumed by createPaginatedFetch; other fields are optional
// to avoid ZodError if the API omits them.
const CloudMetaSchema = z.object({
  pagination: z.object({
    page: z.number().optional(),
    per_page: z.number().optional(),
    previous_page: z.number().nullable().optional(),
    next_page: z.number().nullable(),
    last_page: z.number().nullable().optional(),
    total_entries: z.number().nullable().optional()
  }).optional()
}).optional();

// API Response wrappers
export const ListServersResponseSchema = z.object({
  servers: z.array(HetznerServerSchema),
  meta: CloudMetaSchema
});
export type ListServersResponse = z.infer<typeof ListServersResponseSchema>;

export const GetServerResponseSchema = z.object({
  server: HetznerServerSchema
});

export const CreateServerResponseSchema = z.object({
  server: HetznerServerSchema,
  action: HetznerActionSchema,
  root_password: z.string().nullable()
});

export const ServerActionResponseSchema = z.object({
  action: HetznerActionSchema
});

export const ListServerTypesResponseSchema = z.object({
  server_types: z.array(HetznerServerTypeSchema)
});

export const ListImagesResponseSchema = z.object({
  images: z.array(HetznerImageSchema)
});

export const ListLocationsResponseSchema = z.object({
  locations: z.array(HetznerLocationSchema)
});

export const ListSSHKeysResponseSchema = z.object({
  ssh_keys: z.array(HetznerSSHKeySchema),
  meta: CloudMetaSchema
});
export type ListSSHKeysResponse = z.infer<typeof ListSSHKeysResponseSchema>;

export const GetSSHKeyResponseSchema = z.object({
  ssh_key: HetznerSSHKeySchema
});

export const CreateSSHKeyResponseSchema = z.object({
  ssh_key: HetznerSSHKeySchema
});

// Storage Box — Zod schemas at API boundary (C-1).
// These schemas are validated at runtime via makeStorageBoxApiRequest, so
// unexpected API response shapes fail loudly with a ZodError instead of
// silently coercing to undefined. Static types are inferred via z.infer to
// keep a single source of truth.

// Pagination envelope returned by Hetzner unified API list endpoints.
// Only `next_page` is consumed by paginatedFetch; the other fields are made
// optional so an API response that omits them does not throw ZodError on
// data we never read (I-1 from /review-pr round 3).
export const HetznerPaginationSchema = z.object({
  page: z.number().optional(),
  per_page: z.number().optional(),
  previous_page: z.number().nullable().optional(),
  next_page: z.number().nullable(),
  last_page: z.number().nullable().optional(),
  total_entries: z.number().nullable().optional()
});

export const HetznerMetaSchema = z.object({
  pagination: HetznerPaginationSchema.optional()
});
export type HetznerMeta = z.infer<typeof HetznerMetaSchema>;

// Unified API (api.hetzner.com/v1) returns a nested structure distinct from
// the legacy Robot API. Field names verified against official docs at
// https://docs.hetzner.cloud/reference/hetzner (issue #13).
// passthrough() on nested schemas tolerates unknown sub-fields if Hetzner
// extends the API in future minor versions.
export const HetznerStorageBoxSchema = z.object({
  id: z.number(),
  name: z.string(),
  username: z.string(),
  status: z.string(),
  // Null during initializing status.
  server: z.string().nullable(),
  system: z.string().nullable(),
  storage_box_type: z.object({
    id: z.number(),
    name: z.string(),
    description: z.string(),
    size: z.number()
  }).passthrough(),
  location: z.object({
    id: z.number(),
    name: z.string(),
    description: z.string(),
    country: z.string(),
    city: z.string()
  }).passthrough(),
  labels: z.record(z.string(), z.string()),
  protection: z.object({
    delete: z.boolean()
  }).passthrough(),
  access_settings: z.object({
    reachable_externally: z.boolean(),
    ssh_enabled: z.boolean(),
    samba_enabled: z.boolean(),
    webdav_enabled: z.boolean(),
    zfs_enabled: z.boolean()
  }).passthrough(),
  // Flat stats object; values are in bytes.
  stats: z.object({
    size: z.number(),
    size_data: z.number(),
    size_snapshots: z.number()
  }).passthrough(),
  // null when no plan is configured; object when an automatic plan is active.
  // passthrough() so new fields added by Hetzner don't trigger ZodError.
  snapshot_plan: z.object({
    max_snapshots: z.number(),
    minute: z.number(),
    hour: z.number(),
    day_of_week: z.number().nullable(),
    day_of_month: z.number().nullable()
  }).passthrough().nullable(),
  created: z.string()
});
export type HetznerStorageBox = z.infer<typeof HetznerStorageBoxSchema>;

export const HetznerStorageBoxSubaccountSchema = z.object({
  username: z.string(),
  home_directory: z.string(),
  ssh: z.boolean(),
  webdav: z.boolean(),
  samba: z.boolean(),
  external_reachability: z.boolean(),
  readonly: z.boolean(),
  comment: z.string().nullable()
});
export type HetznerStorageBoxSubaccount = z.infer<typeof HetznerStorageBoxSubaccountSchema>;

export const ListStorageBoxesResponseSchema = z.object({
  storage_boxes: z.array(HetznerStorageBoxSchema),
  meta: HetznerMetaSchema.optional()
});
export type ListStorageBoxesResponse = z.infer<typeof ListStorageBoxesResponseSchema>;

export const GetStorageBoxResponseSchema = z.object({
  storage_box: HetznerStorageBoxSchema
});

export const ListStorageBoxSubaccountsResponseSchema = z.object({
  subaccounts: z.array(HetznerStorageBoxSubaccountSchema),
  meta: HetznerMetaSchema.optional()
});
export type ListStorageBoxSubaccountsResponse = z.infer<typeof ListStorageBoxSubaccountsResponseSchema>;

export const HetznerStorageBoxSnapshotSchema = z.object({
  id: z.number(),
  name: z.string(),
  description: z.string().nullable().optional(),
  stats: z
    .object({
      size: z.number().optional(),
      size_filesystem: z.number().optional()
    })
    .optional(),
  is_automatic: z.boolean().optional(),
  storage_box: z.number().optional(),
  created: z.string(),
  labels: z.record(z.string(), z.string()).optional()
});
export type HetznerStorageBoxSnapshot = z.infer<typeof HetznerStorageBoxSnapshotSchema>;

export const ListStorageBoxSnapshotsResponseSchema = z.object({
  snapshots: z.array(HetznerStorageBoxSnapshotSchema),
  meta: HetznerMetaSchema.optional()
});
export type ListStorageBoxSnapshotsResponse = z.infer<typeof ListStorageBoxSnapshotsResponseSchema>;

export const CreateStorageBoxSnapshotResponseSchema = z.object({
  snapshot: HetznerStorageBoxSnapshotSchema,
  action: HetznerActionSchema
});

export const RollbackStorageBoxSnapshotResponseSchema = z.object({
  action: HetznerActionSchema
});

// Shared action response for DELETE and action endpoints.
// RollbackStorageBoxSnapshotResponseSchema is kept as a separate alias for
// backwards compat; new tools use StorageBoxActionResponseSchema directly.
export const StorageBoxActionResponseSchema = z.object({
  action: HetznerActionSchema
});

// Create Storage Box — response includes both the new box and an action.
export const CreateStorageBoxResponseSchema = z.object({
  storage_box: HetznerStorageBoxSchema,
  action: HetznerActionSchema
});

// Update Storage Box — returns just the updated box.
export const UpdateStorageBoxResponseSchema = z.object({
  storage_box: HetznerStorageBoxSchema
});

// List folders — folders is a plain string array.
export const ListFoldersResponseSchema = z.object({
  folders: z.array(z.string())
});

// Subaccount create / update — returns the subaccount object.
export const CreateSubaccountResponseSchema = z.object({
  subaccount: HetznerStorageBoxSubaccountSchema
});

export const UpdateSubaccountResponseSchema = z.object({
  subaccount: HetznerStorageBoxSubaccountSchema
});

// Server Metrics
const MetricsTimeSeriesEntrySchema = z.object({
  values: z.array(z.tuple([z.number(), z.string()]))
});

export const ServerMetricsResponseSchema = z.object({
  metrics: z.object({
    start: z.string(),
    end: z.string(),
    step: z.number(),
    time_series: z.record(z.string(), MetricsTimeSeriesEntrySchema)
  })
});

// Cloud Volume
export const HetznerVolumeSchema = z.object({
  id: z.number(),
  name: z.string(),
  // z.string() instead of z.enum to tolerate future Hetzner status values
  // without throwing ZodError at the API boundary (e.g. "deleting", "error").
  status: z.string(),
  size: z.number(),
  location: HetznerLocationSchema,
  server: z.number().nullable(),
  linux_device: z.string().nullable(),
  protection: z.object({
    delete: z.boolean()
  }),
  labels: z.record(z.string(), z.string()),
  format: z.string().nullable(),
  created: z.string()
});
export type HetznerVolume = z.infer<typeof HetznerVolumeSchema>;

export const ListVolumesResponseSchema = z.object({
  volumes: z.array(HetznerVolumeSchema),
  meta: CloudMetaSchema
});
export type ListVolumesResponse = z.infer<typeof ListVolumesResponseSchema>;

export const GetVolumeResponseSchema = z.object({
  volume: HetznerVolumeSchema
});

export const VolumeActionResponseSchema = z.object({
  action: HetznerActionSchema
});
