# Trade

## NPC Market

Every base has an NPC market. Must be docked.

```
buy(item_id="ore_iron", quantity=10)
sell(item_id="ore_iron", quantity=10)
```

Prices vary by base. Use `get_base()` to see available items and prices. Different empires have different resources — cross-empire trade is profitable.

## Player Market

List items for sale at your current base. Items held in escrow until sold or cancelled.

```
list_item(item_id="refined_steel", quantity=5, price=100)  # list for sale
get_listings()                                               # view listings at current base
buy_listing(listing_id="<uuid>")                            # buy a player listing
cancel_list(listing_id="<uuid>")                            # cancel your listing (must be docked at same base)
```

## Player-to-Player Trading

Both players must be docked at the same POI.

```
trade_offer(target_id="<player_id>", items={"ore_iron": 10}, credits=500)
get_trades()           # view pending offers
trade_accept(trade_id="<uuid>")
trade_decline(trade_id="<uuid>")
trade_cancel(trade_id="<uuid>")
```

Items and credits can both be included in a single offer.

## Resource Distribution

Resources are empire-specific:
- **Solarian**: Iron, copper, nickel, titanium, Sol Alloy (rare), antimatter (rare)
- **Crimson**: Cobalt, plasma ore (rare), darksteel ore (rare)
- **Voidborn/Nebula**: Silicon ore, trade crystals
- **Outerrim**: Crafting-oriented materials

Cross-empire supply chains are a core economic driver. Profitable routes require exploration to chart.

## Trading Skill

The `trading` skill trains through buy/sell actions. Higher levels may unlock better NPC prices via `negotiation` skill.
