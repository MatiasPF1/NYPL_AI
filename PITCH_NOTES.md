# SafeRoute NYC — speaker notes

Three slides, ~3 minutes. Safety-from-history is the spine; flood/weather is the
bonus layer that proves the engine is live, not a static map.

---

## Slide 1 — "It's 11:47 PM. She still hasn't texted." (~30s)

**Land the silence first. Do not rush this slide.**

- "Everyone in this room has sent that text. *Made it home safe.* And everyone
  in this room has waited for one."
- "Tonight, someone in New York is walking home on the route their phone gave
  them — the fastest one. Their phone knows the traffic. It doesn't know that
  the corner it just routed them through has sent people to the hospital
  fourteen times."
- "We built the routing engine that knows."
- Beat. "SafeRoute NYC. Routing that watches out for the people you love."

> Tone: quiet, unhurried. This is the only slide where you slow down.

---

## Slide 2 — A city of unknowns, after dark (~45s)

**The point of this slide: the danger is already recorded. Nobody routes on it.**

- "Every eleven minutes, a New Yorker is injured in a traffic crash. Forty-seven
  thousand injuries last year. A hundred and eleven people killed walking."
- "Here's what gets us: **none of that is a surprise.** The city has logged every
  one of them. Two and a quarter million crash records, going back to 2012,
  sitting in NYC Open Data — with coordinates."
- "So the dangerous corners are *known*. They're known to the DOT, they're known
  to the data. They are just not known **to the person walking through them at
  midnight.**"
- Pivot to the third stat: "And that's before weather — eleven people drowned in
  basements during Ida. The same streets flood first, every time, and we know
  which ones."
- Close on the callout: "None of these people did anything wrong. They didn't
  know the risk was there until it was too late to route around it."

> If you only get one line out of this slide, it's: **the risk is already in the
> data, it's just not in anyone's directions.**

---

## Slide 3 — The solution + live demo (~75s)

**Order matters: crash history → the detour → the human on the other end.
Flood/weather is a supporting act, mention it inside the demo, don't build a
section around it.**

### The engine (~25s)
- "We took the crash file — 2.2 million records, filtered to 2022 forward
  because pre-COVID traffic doesn't exist anymore — and snapped every injury and
  fatality onto the actual walking network in PostGIS."
- "That gives every street segment in Manhattan a risk score. Not a
  neighbourhood, not a heat blob — **the block.** 110,000 edges, 6,755 of them
  carrying a documented history of someone getting hurt."
- "Then we re-price the map. Every segment costs its length times one plus its
  risk. A* over that gives you the safest path instead of the shortest one."
- *(Only if you have a technical judge)*: "The penalty is multiplicative and
  always ≥ 1, so cost never drops below true distance — which is what keeps
  straight-line distance an admissible heuristic and the A* result actually
  optimal. Make a safe street cheaper than its length and A* quietly returns
  wrong paths and nothing throws."

### The demo (~30s) — one button, three lines
**Press "Dry vs rain — Alphabet City → Delancey St".** It loads the saved walk
and solves it twice, dry and armed, in one click. Nothing to type on stage.

- Point at the lines as you name them: "**White dashed** is what your phone
  gives you. **Green** is ours on a dry night. **Amber** is the same walk when
  it's raining."
- The numbers land themselves — read the middle column: *the fastest way crosses
  **5 blocks** FloodNet has measured underwater. Ours crosses none.*
- "And look at the cost of that." → **34 metres.** "Thirty seconds of your life."
- Flood, in passing — this is the whole weather story, don't expand it: "It's
  pulling live rain per borough. On a dry night the flood term contributes
  exactly zero, so we never scare you with weather that isn't happening. The
  green and amber lines only differ because the sky does."

> If a judge asks whether it's raining right now: it isn't, and the panel says
> so. Both lines were solved by forcing the term off and then on — the gate
> underneath keeps reporting the real sky. Say that plainly; it's a strength.

### The human loop (~20s) — finish here, not on tech
- "Last piece. You share the walk with one person. If you drift off the safe
  route, or you hit SOS, your contact gets an email with your last known
  position — they don't have to be watching an app."
- "It's consent-gated, and we check that server-side on every single alert, not
  in the browser. You can revoke it and tracking stops that second. A safety app
  that quietly tracks people is just a different safety problem."
- Land it: **"Because 'I made it home' shouldn't be a surprise."**

---

## Numbers you should be able to say without looking

| | |
|---|---|
| Crash records processed | 2.27 M (2012–2026), scored on 2022+ |
| Walking network | 35,806 nodes · 110,220 edges |
| Crash-risk segments served | 6,755 |
| Flood-risk segments served | 5,091 |
| Flood trigger | live rain ≥ 4 mm/h, per borough, Open-Meteo |
| Cost function | `length × (1 + 3·crash + 3·flood·raining)` |

### The saved demo walk, memorised

Alphabet City → Delancey St, 1.68 km, ~21 min.

| Line | Distance | What it costs you |
|---|---|---|
| Fastest (white dashed) | 1.68 km | crosses **5 flooded blocks** |
| Safest, dry (green) | 1.68 km | +5 m |
| Safest, in rain (amber) | 1.71 km | +34 m, **0 flooded blocks** |

Rain moves the recommended line by 29 m. That is the entire weather argument.

---

## Landmines — know these before you're asked

**"Is that crime data?"** → No. Say **crash** or **injury history**, never
"crime." Our source is NYPD *Motor Vehicle Collisions*. There is no crime
dataset in the build, and one wrong word here costs you the whole credibility of
the slide. If asked directly: *"Not yet — collisions today. NYPD complaint data
is the same pipeline, it's a scoring script and a column."*

**"How much of the city?"** → Manhattan below 96th, and say it before they ask.
*"The pipeline is geography-agnostic — the limit is one overnight download per
borough, not the design."*

**"Is the AI agent live?"** → The explanation you read on screen is generated
deterministically by the router from the two paths it actually compared — it
cannot hallucinate a reason. Frame that as the choice it is: *"In a safety
product we didn't want an LLM inventing a justification for a route. The
sentence is derived from the diff between the two paths."* The LangGraph/RAG
layer is roadmap — don't present it as built.

**"SMS?"** → Email today, via Resend. Twilio's trial refuses free-form message
bodies — which is exactly what a safety alert is — so that's a paid upgrade, not
a rebuild. The alert is recorded in the database whether or not delivery works.

**"Isn't this just Google Maps with extra steps?"** → *"Google optimises the one
variable everyone already has. We're the only one pricing the variable the city
already measured and nobody routes on."*
