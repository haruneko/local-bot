import type { ActorName } from "../config/settings.js";
import type { ActorRunner } from "./types.js";
import { memoActor } from "./memo.js";
import { webSearchActor, urlBrowseActor } from "./web-search.js";
import { planActor } from "./plan.js";
import { synthesizeActor } from "./synthesize.js";

const ACTOR_REGISTRY = new Map<ActorName, ActorRunner>([
  ["memo",       memoActor],
  ["webSearch",  webSearchActor],
  ["urlBrowse",  urlBrowseActor],
  ["plan",       planActor],
  ["synthesize", synthesizeActor],
]);

export function getActor(name: ActorName): ActorRunner | undefined {
  return ACTOR_REGISTRY.get(name);
}
