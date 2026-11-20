/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as access from "../access.js";
import type * as accountGuards from "../accountGuards.js";
import type * as addressVerification from "../addressVerification.js";
import type * as admin from "../admin.js";
import type * as aircraftFiles from "../aircraftFiles.js";
import type * as aircraftPhotos from "../aircraftPhotos.js";
import type * as aircraftSpruce from "../aircraftSpruce.js";
import type * as aircraftSpruceActions from "../aircraftSpruceActions.js";
import type * as airworthiness from "../airworthiness.js";
import type * as alerts from "../alerts.js";
import type * as attachments from "../attachments.js";
import type * as audit from "../audit.js";
import type * as auditHistory from "../auditHistory.js";
import type * as auth from "../auth.js";
import type * as authCleanup from "../authCleanup.js";
import type * as backups from "../backups.js";
import type * as certifications from "../certifications.js";
import type * as checklists from "../checklists.js";
import type * as collections from "../collections.js";
import type * as componentTemplates from "../componentTemplates.js";
import type * as costs from "../costs.js";
import type * as crons from "../crons.js";
import type * as defaultGroups from "../defaultGroups.js";
import type * as engineTrends from "../engineTrends.js";
import type * as expiringItems from "../expiringItems.js";
import type * as faa from "../faa.js";
import type * as faaCredentials from "../faaCredentials.js";
import type * as faaDrs from "../faaDrs.js";
import type * as faaSearch from "../faaSearch.js";
import type * as fileLinks from "../fileLinks.js";
import type * as fileSweep from "../fileSweep.js";
import type * as fileTokens from "../fileTokens.js";
import type * as fleet from "../fleet.js";
import type * as flightPlans from "../flightPlans.js";
import type * as groupAudit from "../groupAudit.js";
import type * as groupDeletion from "../groupDeletion.js";
import type * as history from "../history.js";
import type * as historyScan from "../historyScan.js";
import type * as http from "../http.js";
import type * as identities from "../identities.js";
import type * as inspectionTemplates from "../inspectionTemplates.js";
import type * as inventoryFiles from "../inventoryFiles.js";
import type * as mailer from "../mailer.js";
import type * as management from "../management.js";
import type * as manuals from "../manuals.js";
import type * as memberships from "../memberships.js";
import type * as migrations from "../migrations.js";
import type * as operations from "../operations.js";
import type * as partsRequests from "../partsRequests.js";
import type * as poFiles from "../poFiles.js";
import type * as programContext from "../programContext.js";
import type * as programUsers from "../programUsers.js";
import type * as programs from "../programs.js";
import type * as purchaseOrders from "../purchaseOrders.js";
import type * as push from "../push.js";
import type * as pushSubscriptions from "../pushSubscriptions.js";
import type * as rateLimits from "../rateLimits.js";
import type * as recordsDate from "../recordsDate.js";
import type * as recurringParts from "../recurringParts.js";
import type * as runCommand from "../runCommand.js";
import type * as sampleDocuments from "../sampleDocuments.js";
import type * as sampleProgram from "../sampleProgram.js";
import type * as savedAddresses from "../savedAddresses.js";
import type * as secrets from "../secrets.js";
import type * as secretsMigration from "../secretsMigration.js";
import type * as spruceHttp from "../spruceHttp.js";
import type * as ssoProviders from "../ssoProviders.js";
import type * as storageReferences from "../storageReferences.js";
import type * as taskCards from "../taskCards.js";
import type * as taskImports from "../taskImports.js";
import type * as urgentAlerts from "../urgentAlerts.js";
import type * as userErrors from "../userErrors.js";
import type * as validators from "../validators.js";
import type * as webPushProtocol from "../webPushProtocol.js";
import type * as workOrderCopies from "../workOrderCopies.js";
import type * as workOrders from "../workOrders.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  access: typeof access;
  accountGuards: typeof accountGuards;
  addressVerification: typeof addressVerification;
  admin: typeof admin;
  aircraftFiles: typeof aircraftFiles;
  aircraftPhotos: typeof aircraftPhotos;
  aircraftSpruce: typeof aircraftSpruce;
  aircraftSpruceActions: typeof aircraftSpruceActions;
  airworthiness: typeof airworthiness;
  alerts: typeof alerts;
  attachments: typeof attachments;
  audit: typeof audit;
  auditHistory: typeof auditHistory;
  auth: typeof auth;
  authCleanup: typeof authCleanup;
  backups: typeof backups;
  certifications: typeof certifications;
  checklists: typeof checklists;
  collections: typeof collections;
  componentTemplates: typeof componentTemplates;
  costs: typeof costs;
  crons: typeof crons;
  defaultGroups: typeof defaultGroups;
  engineTrends: typeof engineTrends;
  expiringItems: typeof expiringItems;
  faa: typeof faa;
  faaCredentials: typeof faaCredentials;
  faaDrs: typeof faaDrs;
  faaSearch: typeof faaSearch;
  fileLinks: typeof fileLinks;
  fileSweep: typeof fileSweep;
  fileTokens: typeof fileTokens;
  fleet: typeof fleet;
  flightPlans: typeof flightPlans;
  groupAudit: typeof groupAudit;
  groupDeletion: typeof groupDeletion;
  history: typeof history;
  historyScan: typeof historyScan;
  http: typeof http;
  identities: typeof identities;
  inspectionTemplates: typeof inspectionTemplates;
  inventoryFiles: typeof inventoryFiles;
  mailer: typeof mailer;
  management: typeof management;
  manuals: typeof manuals;
  memberships: typeof memberships;
  migrations: typeof migrations;
  operations: typeof operations;
  partsRequests: typeof partsRequests;
  poFiles: typeof poFiles;
  programContext: typeof programContext;
  programUsers: typeof programUsers;
  programs: typeof programs;
  purchaseOrders: typeof purchaseOrders;
  push: typeof push;
  pushSubscriptions: typeof pushSubscriptions;
  rateLimits: typeof rateLimits;
  recordsDate: typeof recordsDate;
  recurringParts: typeof recurringParts;
  runCommand: typeof runCommand;
  sampleDocuments: typeof sampleDocuments;
  sampleProgram: typeof sampleProgram;
  savedAddresses: typeof savedAddresses;
  secrets: typeof secrets;
  secretsMigration: typeof secretsMigration;
  spruceHttp: typeof spruceHttp;
  ssoProviders: typeof ssoProviders;
  storageReferences: typeof storageReferences;
  taskCards: typeof taskCards;
  taskImports: typeof taskImports;
  urgentAlerts: typeof urgentAlerts;
  userErrors: typeof userErrors;
  validators: typeof validators;
  webPushProtocol: typeof webPushProtocol;
  workOrderCopies: typeof workOrderCopies;
  workOrders: typeof workOrders;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
