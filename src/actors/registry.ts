import type { ActorName } from "../config/settings.js";
import type { ActorRunner } from "./types.js";
import { recallActor } from "./recall.js";
import { rememberActor } from "./remember.js";
import { forgetActor } from "./forget.js";
import { memoActor } from "./memo.js";
import { webSearchActor, urlBrowseActor } from "./web-search.js";
import { planActor } from "./plan.js";

const ACTOR_REGISTRY = new Map<ActorName, ActorRunner>([
  ["recall",    recallActor],
  ["remember",  rememberActor],
  ["forget",    forgetActor],
  ["memo",      memoActor],
  ["webSearch", webSearchActor],
  ["urlBrowse", urlBrowseActor],
  ["plan",      planActor],
]);

export function getActor(name: ActorName): ActorRunner | undefined {
  return ACTOR_REGISTRY.get(name);
}
