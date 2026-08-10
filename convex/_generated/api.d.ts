/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as act from "../act.js";
import type * as bankManager from "../bankManager.js";
import type * as committee from "../committee.js";
import type * as community from "../community.js";
import type * as crons from "../crons.js";
import type * as economy from "../economy.js";
import type * as http from "../http.js";
import type * as kernel from "../kernel.js";
import type * as pathfinding from "../pathfinding.js";
import type * as planning from "../planning.js";
import type * as plotsData from "../plotsData.js";
import type * as security from "../security.js";
import type * as seed from "../seed.js";
import type * as walkable from "../walkable.js";
import type * as world from "../world.js";
import type * as worldGrid from "../worldGrid.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  act: typeof act;
  bankManager: typeof bankManager;
  committee: typeof committee;
  community: typeof community;
  crons: typeof crons;
  economy: typeof economy;
  http: typeof http;
  kernel: typeof kernel;
  pathfinding: typeof pathfinding;
  planning: typeof planning;
  plotsData: typeof plotsData;
  security: typeof security;
  seed: typeof seed;
  walkable: typeof walkable;
  world: typeof world;
  worldGrid: typeof worldGrid;
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
