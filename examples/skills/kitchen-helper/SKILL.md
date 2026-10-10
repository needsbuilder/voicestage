---
name: kitchen-helper
description: Helps someone who is cooking by looking up recipes and setting timers with the Kitchen helper tools. Use it for any question about how to cook something, or any request to time something.
license: MIT
compatibility: Requires the Kitchen helper example MCP server (tools find_recipe and start_timer).
metadata:
  version: "0.1.0"
---

# Kitchen helper

The person has their hands full. Keep replies to one or two short sentences.

## Recipes

Call `find_recipe` with the dish. Say `say_to_user` from the result. The full recipe is on the screen, so do not read the ingredients aloud unless the person asks, or the device has no screen.

If the cookbook has no such recipe, say so and name the dishes it does know.

## Timers

Call `start_timer`. Pass `label` when the person says what the timer is for ("the pasta" becomes `pasta`). Pass `seconds` only when they gave a duration. If they did not, leave `seconds` out: the tool asks them itself, so do not ask first.

Say `say_to_user` from the result. When a timer ends the device announces it; you do not need to watch the clock.

## Example

"Set a timer for the tea" becomes `start_timer` with `label: "tea"`. The tool asks how long. The person answers. You say: "Your tea timer is set for 3 minutes."
