# The design brief, the deep way

Your ask: "the UI is generic and obviously vibe-coded; menu names aren't normie-friendly; holders and other information should be on a front page that explains the platform with good animation and copy; it has to look agency-designed and work on every phone screen." Before rewriting that into the prompt we execute, the four questions.

## 1. What a top professional would do that you are not asking for

- **Decide what the product *is* before touching a pixel.** Generic UIs come from having no concept; every screen then defaults to cards in a grid. A design lead would write a one-sentence positioning ("the daily briefing for NAM: what moved, who moved it, what it costs to trade") and a named visual concept that every screen derives from. "High-end agency look" is a *result* of that, not a style you apply.
- **Design the reading order, not the panels.** A front page is not a dashboard of equal tiles. It is read top to bottom: first the one number, then the sentence that explains it, then the three things that changed, then the depth. They would specify that order for each screen and at each width.
- **Write the copy first.** Every label, menu name, number caption and explainer is written and read by a non-crypto person *before* layout. Two vocabularies live on the same screen: the plain word first ("locked for staking"), the precise term one tap away ("bonded, 13.75-day unbonding").
- **Build an actual system, then audit every screen against it.** A type scale on a ratio, a 4/8-pt spacing scale, one signature colour plus a disciplined neutral range, elevation and border rules, motion with three durations and a reduced-motion path, a component library with every state. "Looks designed" is mostly *consistency you can feel*.
- **Mobile first, literally.** Each screen is designed at 375 px before it is widened. Tables become lists; the header becomes a bar; the first screenful says everything.
- **Put it in front of strangers.** Five-second tests ("what is this site?") and task tests with people who do not hold NAM. Your friend's reaction is a datapoint; five strangers are evidence.

## 2. The rawest material

Not the current screens. The raw material is:

- the **decision inventory and the data** we already have (docs/decisions.md, the API): the numbers that actually matter, and their provenance, which is the product's real differentiator and must stay visible;
- **the words people use**: Namada forum and Discord posts about price, staking and bridging (the terminal already indexes the forum), so the copy uses their phrases, not ours;
- **the screens these users already trust** — Osmosis app, Namadillo, Keplr, Mintscan — whose visual vocabulary sets expectations for what "credible" looks like here;
- **Namada's own brand**: the yellow, the typeface, the tone on namada.net, so this reads as a sibling product, not a clone or a stranger;
- **your trades** (private/trades.md, not published) and the task tests, as the content of the front page's "what this is for";
- **five strangers**, recorded answering "what is this?" after five seconds on the home page.

## 3. Methods and tools

Content-first design (copy deck before layout); reading-order hierarchy per breakpoint; a token system (OKLCH palette validated for contrast, modular type scale, 8-pt spacing, radius/elevation scales) in CSS variables; one display face + one text face + one mono for numbers with tabular figures; motion principles (enter / change / emphasis, 150–300 ms, easing curves, `prefers-reduced-motion`); progressive disclosure with a glossary layer (every term defined on hover/tap); the five-second test and the squint test; Nielsen heuristic review; WCAG 2.1 AA audit; mobile-first breakpoints checked with real screenshots at 360/375/390/768/1280; Lighthouse for performance so animation never costs load time; a design critique by people outside the project.

## 4. What, other than you or me, shows it is right

- **Five-second test**: ≥4 of 5 strangers can say what the site is and who it is for.
- **Task tests** (docs/task-tests.md) run with both traders and non-holders: new UI wins on time and accuracy.
- **The believer test**: your friend, and two other Namada people, blind-rate three screenshots (ours, Osmosis, a generic template) for "built by a team / built by a prompt".
- **Automated gates**: Lighthouse mobile ≥ 90 performance / ≥ 95 accessibility; contrast validator passes every colour pair; a copy lint that flags any undefined jargon; a screenshot test at 360 px with zero horizontal overflow on every screen.

## The rewritten prompt

> Redesign NamadaTrade so that a non-crypto adult understands what it is within five seconds and a NAM trader still gets every number with its provenance, on any phone.
>
> **Phase A — Audit and brief.** From the code, docs/decisions.md and the owner's private trade notes, produce a written design brief: (1) the generic "built by a prompt" tells in the current UI, with file and line; (2) every label, menu name and caption rewritten in plain language, with the precise term kept one tap away, and a glossary; (3) what best-in-class financial and data products do concretely (type, grid, density, motion, copy) and what Namada's own brand gives us; (4) the mobile failures per screen and the pattern that fixes each; (5) what the front page must do for both audiences, in reading order, with the numbers that belong on it (price, holders, supply split, what changed today) and animation that carries meaning; (6) the non-negotiables from the trust model that the redesign must keep.
>
> **Phase B — Design.** Three independent design directions, each a complete system (concept, tokens, type, colour, motion, navigation model and names, home page, one view at 375 px and at 1280 px, copy deck). Judges score them against the brief; synthesise the winner, grafting the best ideas from the others. Output: docs/design/system.md, the token file, the copy deck.
>
> **Phase C — Build.** Implement the system as CSS tokens and primitives, the new navigation and home page, then every view, mobile first. Keep Num/ProvBadge provenance, replay, alerts and login intact. Commit per piece.
>
> **Phase D — Prove.** Adversarial reviews (design critic, a non-crypto reader, accessibility, code), the automated gates above, screenshots at 360/390/768/1280 for every screen, and the test scripts for the five-second and believer tests you will run with people.
