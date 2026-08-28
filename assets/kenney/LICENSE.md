# Where the art comes from

Every model in `public/models/` is from [Kenney](https://kenney.nl), released
under **Creative Commons Zero (CC0)** — public domain, no attribution required,
free for commercial use, no strings.

Attribution is given here anyway, because someone spent years making these and
"not required" is not the same as "not deserved".

| Kit | Used for | Models |
|---|---|---|
| City Kit (Suburban) | homes | 12 of 40 |
| City Kit (Commercial) | civic buildings, workshops, data centres | 8 of 41 |
| Blocky Characters | citizens | 18 of 18 |
| Nature Kit | trees, planting | 14 of 329 |
| Fantasy Town Kit | fountains | 1 of 167 |

The full downloaded kits live in `assets/kenney/` and are **not** shipped — only
the models actually placed in the world are copied into `public/models/`, which
is why the payload is 4.9 MB rather than 112 MB.

## Why this mattered more than the renderer

The world looked like programmer art because it *was* programmer art: every
house, tree and person was assembled at runtime out of axis-aligned boxes by
code. There were no assets in the project of any kind. No engine fixes that —
Unity, Godot, Babylon and Unreal would each have reproduced the same picture.

## The one that decided the approach

Kenney's Blocky Characters carry 27 animations and **no skin**. They are rigid
parts moved by node transforms — `torso`, `head`, `arm-left`, `arm-right`,
`leg-left`, `leg-right` — which happens to be exactly the joint set the
instanced rig here already had.

That is why the whole cast costs ONE draw call. A skinned character would have
capped the town at about thirty people on screen.
