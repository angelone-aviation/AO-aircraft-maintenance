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
import type * as addressVerification from "../addressVerification.js";
import type * as admin from "../admin.js";
import type * as alerts from "../alerts.js";
import type * as aircraftPhotos from "../aircraftPhotos.js";
import type * as aircraftSpruce from "../aircraftSpruce.js";
import type * as aircraftSpruceActions from "../aircraftSpruceActions.js";
import type * as airworthiness from "../airworthiness.js";
import type * as audit from "../audit.js";
import type * as auditHistory from "../auditHistory.js";
import type * as auth from "../auth.js";
import type * as certifications from "../certifications.js";
import type * as checklists from "../checklists.js";
import type * as componentTemplates from "../componentTemplates.js";
import type * as costs from "../costs.js";
import type * as counterEvents from "../counterEvents.js";
import type * as crons from "../crons.js";
import type * as defaultGroups from "../defaultGroups.js";
import type * as engineTrends from "../engineTrends.js";
import type * as faa from "../faa.js";
import type * as faaCredentials from "../faaCredentials.js";
import type * as faaSearch from "../faaSearch.js";
import type * as fleet from "../fleet.js";
import type * as flightPlans from "../flightPlans.js";
import type * as groupAudit from "../groupAudit.js";
import type * as groupDeletion from "../groupDeletion.js";
import type * as http from "../http.js";
import type * as inspectionTemplates from "../inspectionTemplates.js";
import type * as inventoryFiles from "../inventoryFiles.js";
import type * as management from "../management.js";
import type * as manuals from "../manuals.js";
import type * as memberships from "../memberships.js";
import type * as operations from "../operations.js";
import type * as partsRequests from "../partsRequests.js";
import type * as poFiles from "../poFiles.js";
import type * as programContext from "../programContext.js";
import type * as programUsers from "../programUsers.js";
import type * as programs from "../programs.js";
import type * as purchaseOrders from "../purchaseOrders.js";
import type * as recurringParts from "../recurringParts.js";
import type * as sampleDocuments from "../sampleDocuments.js";
import type * as sampleProgram from "../sampleProgram.js";
import type * as savedAddresses from "../savedAddresses.js";
import type * as secretsMigration from "../secretsMigration.js";
import type * as spruceHttp from "../spruceHttp.js";
import type * as taskCards from "../taskCards.js";
import type * as taskImports from "../taskImports.js";
import type * as validators from "../validators.js";
import type * as workOrderCleanup from "../workOrderCleanup.js";
import type * as workOrderCopies from "../workOrderCopies.js";
import type * as workOrders from "../workOrders.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  access: typeof access;
  addressVerification: typeof addressVerification;
  admin: typeof admin;
  alerts: typeof alerts;
  aircraftPhotos: typeof aircraftPhotos;
  aircraftSpruce: typeof aircraftSpruce;
  aircraftSpruceActions: typeof aircraftSpruceActions;
  airworthiness: typeof airworthiness;
  audit: typeof audit;
  auditHistory: typeof auditHistory;
  auth: typeof auth;
  certifications: typeof certifications;
  checklists: typeof checklists;
  componentTemplates: typeof componentTemplates;
  costs: typeof costs;
  counterEvents: typeof counterEvents;
  crons: typeof crons;
  defaultGroups: typeof defaultGroups;
  engineTrends: typeof engineTrends;
  faa: typeof faa;
  faaCredentials: typeof faaCredentials;
  faaSearch: typeof faaSearch;
  fleet: typeof fleet;
  flightPlans: typeof flightPlans;
  groupAudit: typeof groupAudit;
  groupDeletion: typeof groupDeletion;
  http: typeof http;
  inspectionTemplates: typeof inspectionTemplates;
  inventoryFiles: typeof inventoryFiles;
  management: typeof management;
  manuals: typeof manuals;
  memberships: typeof memberships;
  operations: typeof operations;
  partsRequests: typeof partsRequests;
  poFiles: typeof poFiles;
  programContext: typeof programContext;
  programUsers: typeof programUsers;
  programs: typeof programs;
  purchaseOrders: typeof purchaseOrders;
  recurringParts: typeof recurringParts;
  sampleDocuments: typeof sampleDocuments;
  sampleProgram: typeof sampleProgram;
  savedAddresses: typeof savedAddresses;
  secretsMigration: typeof secretsMigration;
  spruceHttp: typeof spruceHttp;
  taskCards: typeof taskCards;
  taskImports: typeof taskImports;
  validators: typeof validators;
  workOrderCleanup: typeof workOrderCleanup;
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
