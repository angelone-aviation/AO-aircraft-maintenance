/**
 * Responsibility: The database schema: each table's document validator and
 *   indexes.
 * Layer: Server. Declarations Convex checks every write against; no logic.
 * Dependencies: convex/server, convex/values, @convex-dev/auth/server,
 *   ./validators, src/domain/ata.
 *
 * Most records are one JSON `payload` per row, checked by the domain's zod
 * schemas (convex/collections.ts), so a new record field changes this file
 * only when it needs an index. Each table that holds a file has a "storage"
 * index for the blob clean-up (convex/storageReferences.ts).
 */
import { ATA_CHAPTERS } from "../src/domain/ata";
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { authTables } from "@convex-dev/auth/server";
import {
  aircraftFields,
  deferralValidator,
  dispatchOverrideValidator,
  flightFields,
  permission,
} from "./validators";

/**
 * The deployment's tables: Convex Auth's, then the app's. Convex refuses a
 * deploy whose schema the stored documents do not match, so a new column
 * starts optional.
 */
export default defineSchema({
  ...authTables,
  aircraftPhotos: defineTable({
    aircraftUuid: v.string(),
    storageId: v.id("_storage"),
  })
    .index("aircraft", ["aircraftUuid"])
    .index("storage", ["storageId"]),
  // Documents kept on the aircraft record, such as Form 337 copies. Status
  // records are never deleted: archiving hides a copy and keeps its file.
  aircraftFiles: defineTable({
    aircraftUuid: v.string(),
    category: v.union(v.literal("form-337"), v.literal("logbook-page")),
    // A logbook page photo names the flight or work order it shows.
    linkedKind: v.optional(
      v.union(v.literal("flight"), v.literal("work-order")),
    ),
    linkedUuid: v.optional(v.string()),
    storageId: v.id("_storage"),
    name: v.string(),
    type: v.string(),
    size: v.number(),
    uploadedAt: v.number(),
    archivedAt: v.optional(v.number()),
    archivedBy: v.optional(v.object({ userId: v.string(), name: v.string() })),
    archiveReason: v.optional(v.string()),
  })
    .index("aircraft", ["aircraftUuid"])
    .index("storage", ["storageId"]),
  savedAddresses: defineTable({
    uuid: v.string(),
    programUuid: v.string(),
    version: v.number(),
    name: v.string(),
    nameKey: v.string(),
    address: v.object({
      addressName: v.optional(v.string()),
      organization: v.string(),
      street: v.string(),
      street2: v.string(),
      city: v.string(),
      region: v.string(),
      postalCode: v.string(),
      country: v.string(),
      contactName: v.string(),
      email: v.string(),
      phone: v.string(),
      confirmed: v.boolean(),
    }),
  })
    .index("program", ["programUuid"])
    .index("uuid", ["uuid"])
    .index("name", ["programUuid", "nameKey"]),
  spruceAccounts: defineTable({
    programUuid: v.string(),
    version: v.number(),
    // userid, password and apikey are sealed (convex/secrets.ts).
    credentials: v.optional(
      v.object({
        userid: v.string(),
        password: v.string(),
        apikey: v.string(),
        currency: v.string(),
      }),
    ),
    catalogId: v.optional(v.id("_storage")),
    catalogAt: v.optional(v.number()),
    catalogCount: v.optional(v.number()),
  })
    .index("program", ["programUuid"])
    .index("storage", ["catalogId"]),
  spruceOrders: defineTable({
    programUuid: v.string(),
    poUuid: v.string(),
    accountVersion: v.number(),
    fetchedAt: v.number(),
    order: v.string(),
    rows: v.array(v.record(v.string(), v.string())),
  }).index("po", ["programUuid", "poUuid"]),
  certificationFiles: defineTable({
    userId: v.id("users"),
    kind: v.string(),
    storageId: v.id("_storage"),
    name: v.string(),
    type: v.string(),
    size: v.number(),
    uploadedAt: v.number(),
  })
    .index("user", ["userId"])
    .index("storage", ["storageId"]),
  // Convex Auth's users table with the app's fields added; the library's own
  // (name to isAnonymous) stay as it writes them. Its "phone" index is left
  // out: only the library's default account linking reads it, and
  // createOrUpdateUser (convex/auth.ts) replaces that.
  users: defineTable({
    certifications: v.optional(
      v.array(
        v.object({
          kind: v.string(),
          number: v.string(),
          issuedOn: v.string(),
          expiresOn: v.optional(v.string()),
          renewalDate: v.optional(v.string()),
          airframe: v.optional(v.boolean()),
          powerplant: v.optional(v.boolean()),
          ia: v.optional(v.boolean()),
          legacyQualifications: v.optional(
            v.array(
              v.object({
                kind: v.string(),
                number: v.string(),
                issuedOn: v.string(),
                expiresOn: v.optional(v.string()),
                renewalDate: v.optional(v.string()),
              }),
            ),
          ),
        }),
      ),
    ),
    licenseNumber: v.optional(v.string()),
    logbookPhrases: v.optional(v.array(v.string())),
    releaseStatements: v.optional(
      v.array(v.object({ label: v.string(), text: v.string() })),
    ),
    certificateType: v.optional(v.string()),
    name: v.optional(v.string()),
    email: v.optional(v.string()),
    image: v.optional(v.string()),
    emailVerificationTime: v.optional(v.number()),
    phone: v.optional(v.string()),
    phoneVerificationTime: v.optional(v.number()),
    isAnonymous: v.optional(v.boolean()),
    active: v.optional(v.boolean()),
    isAdmin: v.optional(v.boolean()),
    activeProgramUuid: v.optional(v.string()),
    emailAlerts: v.optional(v.boolean()),
    urgentAlertEmails: v.optional(v.boolean()),
    groupIds: v.optional(v.array(v.id("groups"))),
  }).index("email", ["email"]),
  alertReads: defineTable({
    userId: v.id("users"),
    programUuid: v.string(),
    key: v.string(),
    readAt: v.number(),
  }).index("user_program", ["userId", "programUuid", "key"]),
  // One row per alert sent to a member on a channel; rows from before
  // channels exist have none and count as "digest".
  alertDeliveries: defineTable({
    userId: v.id("users"),
    programUuid: v.string(),
    key: v.string(),
    sentAt: v.number(),
    channel: v.optional(
      v.union(v.literal("digest"), v.literal("immediate"), v.literal("push")),
    ),
  }).index("user_program", ["userId", "programUuid", "key"]),
  // A device a member asked to be alerted on (Web Push); the endpoint is the
  // push service's address for that device and browser.
  pushSubscriptions: defineTable({
    userId: v.id("users"),
    programUuid: v.optional(v.string()),
    endpoint: v.string(),
    keys: v.object({ p256dh: v.string(), auth: v.string() }),
    userAgent: v.optional(v.string()),
    createdAt: v.number(),
    lastSeenAt: v.number(),
    // Sends the push service refused for good (401, 403) in a row.
    refusals: v.optional(v.number()),
  })
    .index("user", ["userId"])
    .index("endpoint", ["endpoint"]),
  // Expiring dates (insurance, registration, service keys, secrets); a row
  // without a program is the deployment's own (src/domain/expiringItems.ts).
  expiringItems: defineTable({
    uuid: v.string(),
    programUuid: v.optional(v.string()),
    payload: v.string(),
  })
    .index("uuid", ["uuid"])
    .index("program", ["programUuid"]),
  // Derived index of users.groupIds (the authorization source of truth),
  // kept in sync by convex/memberships.ts.
  memberships: defineTable({
    userId: v.id("users"),
    groupId: v.id("groups"),
    programUuid: v.optional(v.string()),
  })
    .index("program", ["programUuid", "groupId"])
    .index("user", ["userId"]),
  groups: defineTable({
    programUuid: v.optional(v.string()),
    programAdmin: v.optional(v.boolean()),
    owner: v.optional(v.boolean()),
    board: v.optional(v.boolean()),
    name: v.string(),
    aircraftIds: v.array(v.string()),
    permissions: v.array(permission),
  }).index("program", ["programUuid"]),
  programs: defineTable({
    uuid: v.string(),
    version: v.number(),
    name: v.string(),
    addressDetails: v.optional(
      v.object({
        organization: v.string(),
        street: v.string(),
        street2: v.string(),
        city: v.string(),
        region: v.string(),
        postalCode: v.string(),
        country: v.string(),
        contactName: v.string(),
        email: v.string(),
        phone: v.string(),
        confirmed: v.boolean(),
      }),
    ),
    address: v.string(),
    email: v.string(),
    contactName: v.string(),
    website: v.string(),
  }).index("uuid", ["uuid"]),
  aircraft: defineTable(aircraftFields)
    .index("uuid", ["uuid"])
    .index("registration", ["registration"])
    .index("program", ["programUuid"]),
  componentTemplates: defineTable({
    uuid: v.string(),
    programUuid: v.string(),
    payload: v.string(),
  })
    .index("uuid", ["uuid"])
    .index("program", ["programUuid"]),
  componentSetups: defineTable({
    uuid: v.string(),
    programUuid: v.string(),
    aircraftUuid: v.string(),
    payload: v.string(),
  })
    .index("uuid", ["uuid"])
    .index("program", ["programUuid"]),
  inspectionTemplates: defineTable({
    uuid: v.string(),
    programUuid: v.optional(v.string()),
    payload: v.string(),
  })
    .index("uuid", ["uuid"])
    .index("program", ["programUuid"]),
  manuals: defineTable({
    applicability: v.optional(
      v.object({
        kind: v.union(v.literal("aircraft"), v.literal("component")),
        manufacturer: v.string(),
        model: v.string(),
        partNumber: v.string(),
      }),
    ),
    uuid: v.string(),
    aircraftUuid: v.string(),
    title: v.string(),
    documentNumber: v.string(),
    revision: v.string(),
    revisionDate: v.string(),
    filename: v.string(),
    size: v.number(),
    pageCount: v.number(),
    storageId: v.id("_storage"),
    uploadedAt: v.number(),
    uploadedBy: v.string(),
  })
    .index("uuid", ["uuid"])
    .index("storage", ["storageId"])
    .index("aircraft", ["aircraftUuid"]),
  manualUploads: defineTable({
    payload: v.string(),
    userId: v.string(),
    createdAt: v.number(),
    // Base64 SHA-256 the browser declared; only a blob with these bytes can be
    // claimed.
    sha256: v.optional(v.string()),
    storageId: v.optional(v.id("_storage")),
  })
    .index("createdAt", ["createdAt"])
    .index("storage", ["storageId"]),
  archivedTaskCards: defineTable({
    uuid: v.string(),
    aircraftUuid: v.string(),
    payload: v.string(),
  })
    .index("uuid", ["uuid"])
    .index("aircraft", ["aircraftUuid"]),
  taskCards: defineTable({
    uuid: v.string(),
    aircraftUuid: v.string(),
    payload: v.string(),
  })
    .index("uuid", ["uuid"])
    .index("aircraft", ["aircraftUuid"]),
  taskEvidence: defineTable({
    taskCardUuid: v.string(),
    // The job card's aircraft, so the snapshot reads evidence once per
    // aircraft. Rows uploaded before it was stored lack it until
    // attachments:backfillAircraft runs.
    aircraftUuid: v.optional(v.string()),
    storageId: v.id("_storage"),
    name: v.string(),
    size: v.number(),
    uploadedAt: v.number(),
    category: v.union(
      v.literal("photo"),
      v.literal("supporting-document"),
      v.literal("parts-traceability"),
    ),
  })
    .index("taskCard", ["taskCardUuid"])
    .index("aircraft", ["aircraftUuid"])
    .index("storage", ["storageId"]),
  rateLimits: defineTable({
    key: v.string(),
    windowStart: v.number(),
    count: v.number(),
  }).index("key", ["key"]),
  // The one row of the hourly clean-up of unreferenced files
  // (convex/fileSweep.ts): the creation time of the newest file it checked.
  fileSweep: defineTable({ checkedThrough: v.number() }),
  // The one Geoapify row: the sealed API key, and the UTC day's lookup count
  // that caps lookups for the whole deployment.
  addressVerificationSettings: defineTable({
    key: v.optional(v.string()),
    version: v.number(),
    day: v.string(),
    used: v.number(),
    lastLookupAt: v.number(),
  }),
  // One row per completed credential migration (see secretsMigration.ts).
  credentialMigrations: defineTable({
    name: v.string(),
    keyId: v.string(),
    completedAt: v.number(),
  }).index("name", ["name"]),
  // The one FAA DRS key row; `key` is sealed (convex/secrets.ts).
  faaCredentials: defineTable({
    key: v.optional(v.string()),
    expiresOn: v.string(),
    version: v.number(),
    updatedAt: v.number(),
  }),
  // One row per successful nightly off-site copy (convex/backups.ts).
  backupRuns: defineTable({
    completedAt: v.number(),
    objectKey: v.string(),
    bytes: v.number(),
    sha256: v.string(),
    monthlyKey: v.optional(v.string()),
    envUploaded: v.boolean(),
    recordedAt: v.number(),
  }).index("completedAt", ["completedAt"]),
  faaMonitors: defineTable({
    aircraftUuid: v.string(),
    payload: v.string(),
  }).index("aircraft", ["aircraftUuid"]),
  airworthiness: defineTable({
    uuid: v.string(),
    aircraftUuid: v.string(),
    programUuid: v.optional(v.string()),
    payload: v.string(),
  })
    .index("uuid", ["uuid"])
    .index("aircraft", ["aircraftUuid"]),
  checklists: defineTable({
    uuid: v.string(),
    programUuid: v.string(),
    aircraftUuid: v.string(),
    payload: v.string(),
  })
    .index("uuid", ["uuid"])
    .index("program", ["programUuid"]),
  workOrderCopyJobs: defineTable({
    uuid: v.string(),
    workOrderUuid: v.string(),
    aircraftUuid: v.string(),
    actorId: v.string(),
    programUuid: v.optional(v.string()),
    status: v.union(
      v.literal("running"),
      v.literal("failed"),
      v.literal("completed"),
    ),
    completed: v.number(),
    total: v.number(),
    batch: v.number(),
    error: v.optional(v.string()),
    scheduledId: v.optional(v.id("_scheduled_functions")),
  }).index("workOrder", ["workOrderUuid"]),
  workOrderCopyBatches: defineTable({
    jobId: v.id("workOrderCopyJobs"),
    batch: v.number(),
    // Immutable template contents captured in the same transaction as the
    // request.
    cards: v.array(
      v.object({
        payload: v.string(),
        uuid: v.string(),
        workTaskUuid: v.string(),
      }),
    ),
  }).index("jobBatch", ["jobId", "batch"]),
  workOrders: defineTable({
    uuid: v.string(),
    aircraftUuid: v.string(),
    payload: v.string(),
  })
    .index("uuid", ["uuid"])
    .index("aircraft", ["aircraftUuid"]),
  inventoryFiles: defineTable({
    stockUuid: v.string(),
    storageId: v.id("_storage"),
    name: v.string(),
    type: v.string(),
    size: v.number(),
    uploadedAt: v.number(),
  })
    .index("stock", ["stockUuid"])
    .index("storage", ["storageId"]),
  workOrderFiles: defineTable({
    workOrderUuid: v.string(),
    // As on taskEvidence: the work order's aircraft, for one read per
    // aircraft.
    aircraftUuid: v.optional(v.string()),
    storageId: v.id("_storage"),
    name: v.string(),
    size: v.number(),
    uploadedAt: v.number(),
  })
    .index("workOrder", ["workOrderUuid"])
    .index("aircraft", ["aircraftUuid"])
    .index("storage", ["storageId"]),
  flightPlans: defineTable({
    uuid: v.string(),
    aircraftUuid: v.string(),
    payload: v.string(),
  })
    .index("uuid", ["uuid"])
    .index("aircraft", ["aircraftUuid"]),
  flights: defineTable({
    ...flightFields,
    uuid: v.string(),
    authorId: v.string(),
    submittedAt: v.number(),
    // "review" is a held flight: it conflicts with the aircraft's counters,
    // which stay unchanged until an administrator reviews it.
    status: v.union(
      v.literal("accepted"),
      v.literal("review"),
      v.literal("rejected"),
    ),
    reviewReason: v.optional(v.string()),
    hobbsOff: v.optional(v.number()),
    tachOff: v.optional(v.number()),
    cyclicHobbsOff: v.optional(v.number()),
    flightTimeLogOff: v.optional(v.number()),
    dispatchOverride: v.optional(dispatchOverrideValidator),
  })
    .index("uuid", ["uuid"])
    .index("aircraft", ["aircraftUuid"])
    .index("plan", ["flightPlanUuid"]),
  discrepancies: defineTable({
    // A problem report has no version of its own; this one guards edits to
    // its required parts (src/domain/requiredParts.ts).
    partsVersion: v.optional(v.number()),
    requiredParts: v.optional(
      v.array(
        v.object({
          locationUuid: v.string(),
          stockUuid: v.string(),
          quantity: v.number(),
        }),
      ),
    ),

    uuid: v.string(),
    aircraftUuid: v.string(),
    flightUuid: v.optional(v.string()),
    description: v.string(),
    status: v.union(v.literal("open"), v.literal("resolved")),
    authorId: v.string(),
    createdAt: v.number(),
    resolution: v.optional(v.string()),
    resolvedBy: v.optional(v.string()),
    resolvedAt: v.optional(v.number()),
    grounding: v.optional(v.boolean()),
    deferral: v.optional(deferralValidator),
  })
    .index("uuid", ["uuid"])
    .index("aircraft", ["aircraftUuid"]),
  partsRequests: defineTable({
    uuid: v.string(),
    programUuid: v.string(),
    payload: v.string(),
  })
    .index("uuid", ["uuid"])
    .index("program", ["programUuid"]),
  purchaseOrders: defineTable({
    uuid: v.string(),
    programUuid: v.string(),
    payload: v.string(),
  })
    .index("uuid", ["uuid"])
    .index("program", ["programUuid"]),
  poFiles: defineTable({
    poUuid: v.string(),
    programUuid: v.string(),
    receiptUuid: v.optional(v.string()),
    storageId: v.id("_storage"),
    name: v.string(),
    type: v.string(),
    size: v.number(),
    uploadedAt: v.number(),
  })
    .index("po", ["poUuid"])
    .index("storage", ["storageId"]),
  management: defineTable({
    programUuid: v.optional(v.string()),
    uuid: v.string(),
    kind: v.union(
      v.literal("component"),
      v.literal("componentRequirement"),
      v.literal("componentMovement"),
      v.literal("stock"),
      v.literal("location"),
      v.literal("vendor"),
    ),
    aircraftUuid: v.optional(v.string()),
    payload: v.string(),
  })
    .index("uuid", ["uuid"])
    .index("program", ["programUuid"]),
  // Maintenance cost records (work-order costs, budgets, labor rate settings).
  // Aircraft rows travel with the aircraft; settings rows use aircraftUuid "".
  costs: defineTable({
    uuid: v.string(),
    programUuid: v.string(),
    aircraftUuid: v.string(),
    payload: v.string(),
  })
    .index("uuid", ["uuid"])
    .index("aircraft", ["aircraftUuid"])
    .index("program", ["programUuid", "aircraftUuid"]),
  // Retired: nothing reads or writes it since commandRequests replaced it. It
  // stays declared only because Convex refuses a deploy whose schema drops a
  // table that still holds rows; a later batch drops it once it is empty.
  managementRequests: defineTable({
    uuid: v.string(),
    actorId: v.string(),
    payload: v.string(),
  }).index("uuid", ["uuid"]),
  // The request id of every runCommand command that carries one, with its
  // caller and payload: a replay is a no-op and any other reuse is refused
  // (convex/runCommand.ts, ADR-0003). It replaced managementRequests.
  commandRequests: defineTable({
    uuid: v.string(),
    actorId: v.string(),
    payload: v.string(),
  }).index("uuid", ["uuid"]),
  inspections: defineTable({
    calendarExempt: v.optional(v.boolean()),
    calendarExemptReason: v.optional(v.string()),
    calendarExemptChangedAt: v.optional(v.number()),
    calendarExemptChangedBy: v.optional(v.string()),
    requiredParts: v.optional(
      v.array(
        v.object({
          locationUuid: v.string(),
          stockUuid: v.string(),
          quantity: v.number(),
        }),
      ),
    ),

    sourceKey: v.optional(v.string()),
    manualReference: v.optional(
      v.union(
        v.null(),
        v.object({
          manualUuid: v.string(),
          section: v.string(),
          printedPage: v.string(),
          pdfPage: v.number(),
        }),
      ),
    ),
    programUuid: v.optional(v.string()),
    ataChapter: v.optional(
      v.union(...ATA_CHAPTERS.map(([code]) => v.literal(code))),
    ),
    usageMeter: v.optional(
      v.union(v.literal("aircraft"), v.literal("collective")),
    ),
    componentUuid: v.optional(v.string()),
    version: v.optional(v.number()),
    intervalSeconds: v.optional(v.number()),
    intervalCycles: v.optional(v.number()),
    intervalLandings: v.optional(v.number()),
    intervalMonths: v.optional(v.number()),
    lastSeconds: v.optional(v.number()),
    lastCycles: v.optional(v.number()),
    lastLandings: v.optional(v.number()),
    lastDate: v.optional(v.string()),
    materials: v.optional(v.string()),
    archived: v.optional(v.boolean()),
    uuid: v.string(),
    aircraftUuid: v.string(),
    reference: v.string(),
    description: v.string(),
    dueSeconds: v.optional(v.number()),
    dueCycles: v.optional(v.number()),
    dueLandings: v.optional(v.number()),
    dueDate: v.optional(v.string()),
  })
    .index("uuid", ["uuid"])
    .index("aircraft", ["aircraftUuid"])
    .index("component", ["componentUuid"]),
  // The change log. Append-only: writeAudit (convex/access.ts) is its only
  // insert, and no code patches or deletes a row (CONTEXT.md §5).
  audit: defineTable({
    programUuid: v.optional(v.string()),
    uuid: v.string(),
    aircraftUuid: v.optional(v.string()),
    actorId: v.string(),
    at: v.number(),
    action: v.string(),
    entityUuid: v.string(),
    reason: v.optional(v.string()),
    before: v.optional(v.string()),
    after: v.optional(v.string()),
  })
    .index("aircraft", ["aircraftUuid"])
    .index("program", ["programUuid"])
    .index("entity", ["entityUuid"]),
  // Change-log rows about records transferred into a program that its own
  // program and aircraft indexes would not reach. Transfers never re-tag audit
  // rows (ADR-0005); this lists them so the program's History feed includes
  // them. Read access is still decided by the record's current owner.
  transferredAudit: defineTable({
    programUuid: v.string(),
    auditId: v.id("audit"),
    auditCreationTime: v.number(),
  }).index("program", ["programUuid", "auditCreationTime"]),
  // One summary per imported engine-monitor file; raw samples are not kept.
  engineTrends: defineTable({
    uuid: v.string(),
    aircraftUuid: v.string(),
    programUuid: v.optional(v.string()),
    payload: v.string(),
  }).index("aircraft", ["aircraftUuid"]),
  engineTrendLimits: defineTable({
    aircraftUuid: v.string(),
    programUuid: v.optional(v.string()),
    chtMaxF: v.number(),
    oilPressureMinPsi: v.number(),
  }).index("aircraft", ["aircraftUuid"]),
});
