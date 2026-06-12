import type { ActorName } from "../config/settings.js";
import type { ActorRunner } from "./types.js";
import { recallActor } from "./recall.js";
import { rememberActor } from "./remember.js";
import { forgetActor } from "./forget.js";
import { memoWriteActor } from "./memo-write.js";
import { memoReadActor } from "./memo-read.js";
import { webSearchActor, urlBrowseActor } from "./web-search.js";
import { planActor } from "./plan.js";

const ACTOR_REGISTRY = new Map<ActorName, ActorRunner>([
  ["recall",    recallActor],
  ["remember",  rememberActor],
  ["forget",    forgetActor],
  ["memoWrite", memoWriteActor],
  ["memoRead",  memoReadActor],
  ["webSearch", webSearchActor],
  ["urlBrowse", urlBrowseActor],
  ["plan",      planActor],
]);

export function getActor(name: ActorName): ActorRunner | undefined {
  return ACTOR_REGISTRY.get(name);
}
