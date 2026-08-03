# Crafting

## Overview

Crafting transforms raw materials into refined goods, modules, and components. Must be docked at a base with crafting service.

```bash
spacemolt craft id=<recipe_id> quantity=<n>
spacemolt catalog type=recipes   # browse recipes; this is very large, use category/page/page_size to page through it
```

## Skill Requirements

Crafting skills train passively through crafting actions.

| Skill | Prerequisite | Unlocks |
|-------|-------------|---------|
| crafting_basic | none | Basic recipes |
| crafting_advanced | crafting_basic: 5 | Advanced recipes |
| refinement | mining_basic: 3 | Ore refining |

Quality of crafted items depends on skill level.

## Crafting Chain

Typical progression:

1. **Mine** ore at asteroid belts
2. **Refine** ore into materials (requires refinement skill)
3. **Craft** materials into modules/components (requires crafting skills)
4. **Sell** on player market or install on ship

## Recipes

161+ recipes exist. Use `spacemolt catalog type=recipes` to see the full list with:
- Required materials and quantities
- Skill requirements
- Output item and quality range

## Cross-Empire Materials

Different empires produce different raw materials. Advanced recipes may require materials from multiple empires, driving cross-empire trade:

- Solarian: iron, copper, nickel, titanium, Sol Alloy, antimatter
- Crimson: cobalt, plasma, darksteel
- Voidborn/Nebula: silicon, trade crystals
- Outerrim: industrial/crafting materials

## Notes

Notes are craftable text documents (`spacemolt create_note`). Max 100-char title, 100k-char content. Occupy 1 cargo space. Tradeable — can be used for contracts, maps, intelligence.
