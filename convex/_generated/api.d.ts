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
import type * as authorities from "../authorities.js";
import type * as bankManager from "../bankManager.js";
import type * as bankSearch from "../bankSearch.js";
import type * as chronicler from "../chronicler.js";
import type * as committee from "../committee.js";
import type * as community from "../community.js";
import type * as crons from "../crons.js";
import type * as earthMapData from "../earthMapData.js";
import type * as economy from "../economy.js";
import type * as embeddings from "../embeddings.js";
import type * as expansion from "../expansion.js";
import type * as greet from "../greet.js";
import type * as handbuild from "../handbuild.js";
import type * as http from "../http.js";
import type * as kernel from "../kernel.js";
import type * as listings from "../listings.js";
import type * as market from "../market.js";
import type * as mcp from "../mcp.js";
import type * as mcpCatalogSeed from "../mcpCatalogSeed.js";
import type * as migrations from "../migrations.js";
import type * as pathfinding from "../pathfinding.js";
import type * as perception from "../perception.js";
import type * as planning from "../planning.js";
import type * as plotsData from "../plotsData.js";
import type * as registrySync from "../registrySync.js";
import type * as scanner from "../scanner.js";
import type * as security from "../security.js";
import type * as seed from "../seed.js";
import type * as takeover from "../takeover.js";
import type * as tiledFounding from "../tiledFounding.js";
import type * as vault from "../vault.js";
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
  authorities: typeof authorities;
  bankManager: typeof bankManager;
  bankSearch: typeof bankSearch;
  chronicler: typeof chronicler;
  committee: typeof committee;
  community: typeof community;
  crons: typeof crons;
  earthMapData: typeof earthMapData;
  economy: typeof economy;
  embeddings: typeof embeddings;
  expansion: typeof expansion;
  greet: typeof greet;
  handbuild: typeof handbuild;
  http: typeof http;
  kernel: typeof kernel;
  listings: typeof listings;
  market: typeof market;
  mcp: typeof mcp;
  mcpCatalogSeed: typeof mcpCatalogSeed;
  migrations: typeof migrations;
  pathfinding: typeof pathfinding;
  perception: typeof perception;
  planning: typeof planning;
  plotsData: typeof plotsData;
  registrySync: typeof registrySync;
  scanner: typeof scanner;
  security: typeof security;
  seed: typeof seed;
  takeover: typeof takeover;
  tiledFounding: typeof tiledFounding;
  vault: typeof vault;
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
