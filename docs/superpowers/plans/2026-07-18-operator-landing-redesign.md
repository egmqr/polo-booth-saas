# PoloPro Operator Landing Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refresh PoloPro landing page into a self-serve conversion experience for photo booth operators.

**Architecture:** Keep existing static single-page structure and app-version fetch logic. Add a Node built-in contract test, then restyle only `index.html` and add accessible mobile navigation.

**Tech Stack:** Static HTML, CSS, vanilla JavaScript, Node.js built-in `node:test`.

## Global Constraints

- Preserve dashboard routes, downloads, version-label loading, product claims, local assets.
- Add no dependencies. Change no backend behavior.
- `Start free` creates account. `Download apps` scrolls to installers.
- Support keyboard focus, reduced motion, responsive layout, touch-sized actions.

---

## File map

- `index.html`: landing markup, visual system, responsive navigation, existing version loader.
- `tests/landing-page.test.mjs`: static conversion/accessibility contract.

### Task 1: Define landing contract

**Files:**

- Create: `tests/landing-page.test.mjs`
- Test: `tests/landing-page.test.mjs`

**Interfaces:** Reads `index.html` with `fs.readFile`; runs with `node --test tests/landing-page.test.mjs`.

- [ ] **Step 1: Write failing test**

```js
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const page = await readFile(new URL('../index.html', import.meta.url), 'utf8');

test('keeps signup as primary operator CTA', () => {
  assert.match(page, /href="\/dashboard\/\?signup=true"[^>]*>\s*(?:<[^>]+>[^<]*<\/[^>]+>\s*)*Start free/s);
});

test('keeps app downloads as secondary path', () => {
  assert.match(page, /href="#apps"[^>]*>\s*(?:<[^>]+>[^<]*<\/[^>]+>\s*)*Download apps/s);
});

test('includes responsive navigation and safeguards', () => {
  assert.match(page, /class="menu-toggle"/);
  assert.match(page, /:focus-visible/);
  assert.match(page, /prefers-reduced-motion: reduce/);
});
```

- [ ] **Step 2: Verify test fails**

Run: `node --test tests/landing-page.test.mjs`

Expected: FAIL because CTA labels and `.menu-toggle` do not exist.

- [ ] **Step 3: Commit test contract**

Run: `git add tests/landing-page.test.mjs; git commit -m "test: define operator landing contract"`

### Task 2: Build operator-first landing

**Files:**

- Modify: `index.html:8-455`
- Test: `tests/landing-page.test.mjs`

**Interfaces:** Keeps IDs `landingWindowsDownload`, `landingAndroidDownload`, `landingWindowsVersion`, and `landingAndroidVersion` unchanged for existing version loader.

- [ ] **Step 1: Make contract pass**

Add accessible navigation:

```html
<button class="menu-toggle" type="button" aria-expanded="false" aria-controls="site-menu">
  <span class="visually-hidden">Open menu</span><i class="bi bi-list"></i>
</button>
<div class="nav-links" id="site-menu">…</div>
```

Use operator-first content:

```html
<p class="hero-kicker"><span class="signal-dot"></span>Built for live event operators</p>
<h1>Run every event<br><em>without losing control.</em></h1>
<p class="hero-copy">Set up, capture, share, and deliver polished photo experiences from one reliable control room.</p>
<a class="btn" href="/dashboard/?signup=true">Start free <i class="bi bi-arrow-up-right"></i></a>
<a class="btn secondary" href="#apps">Download apps</a>
```

Use graphite, white, mint, and coral tokens. Add restrained light-trace border to product visuals. Add visible focus CSS and reduced-motion CSS. Toggle menu state with `aria-expanded`; close menu after nav-link click. Do not alter app-version fetch functions or their target IDs.

- [ ] **Step 2: Verify test passes**

Run: `node --test tests/landing-page.test.mjs`

Expected: PASS with 3 tests, 0 failures.

- [ ] **Step 3: Inspect responsive experience**

Serve repository root and inspect `index.html` at 1440px and 390px widths.

Expected: desktop hierarchy and signup action clear; mobile toggle opens and closes; no horizontal overflow; 44px-or-larger actions; screenshots contained.

- [ ] **Step 4: Commit implementation**

Run: `git add index.html tests/landing-page.test.mjs; git commit -m "feat: refresh operator landing experience"`

### Task 3: Final evidence

**Files:**

- Test: `tests/landing-page.test.mjs`

**Interfaces:** Runs completed landing contract against current `index.html`.

- [ ] **Step 1: Run full contract test**

Run: `node --test tests/landing-page.test.mjs`

Expected: PASS with 3 tests, 0 failures.

- [ ] **Step 2: Check final scope**

Run: `git status --short`

Expected: clean status after implementation commit.

## Plan self-review

- Spec coverage: Task 2 implements visual direction, CTA vocabulary, preserved integrations, mobile navigation, keyboard focus, motion reduction, responsive layout, touch targets.
- Contract coverage: Task 1 protects primary action, secondary action, responsive navigation, focus, and motion safeguards.
- No placeholders, contradictory requirements, or unbound interfaces.

---

## Buyer-priority update

### Task 4: Lead with instant sharing for three capture modes

**Files:**

- Modify: `tests/landing-page.test.mjs`
- Modify: `index.html`

**Interfaces:** The landing page continues to use `/dashboard/?signup=true` for signup and `#apps` for downloads. Existing gallery, download, and app-version IDs remain unchanged.

- [ ] **Step 1: Write failing buyer-priority test**

```js
test('leads three workflows with instant QR sharing and live gallery', () => {
  assert.match(page, /Every shot, shared in seconds\./);
  assert.match(page, /Roving photoman/);
  assert.match(page, /On-site studio photography/);
  assert.match(page, /Static booth with countdown/);
  assert.match(page, /QR sharing/);
  assert.match(page, /live web gallery/i);
  assert.ok(page.indexOf('Roving photoman') < page.indexOf('On-site studio photography'));
  assert.ok(page.indexOf('On-site studio photography') < page.indexOf('Static booth with countdown'));
});
```

- [ ] **Step 2: Verify red**

Run: `node --test tests/landing-page.test.mjs`

Expected: FAIL because page does not yet describe all ranked capture modes or instant-sharing headline.

- [ ] **Step 3: Implement smallest content update**

Replace hero headline and copy with instant sharing and live gallery outcome. Replace four-step workflow with three cards, in fixed order:

```text
Roving photoman — send every roaming capture straight to guest QR access and live gallery.
On-site studio photography — keep portrait sessions flowing with QR delivery and gallery visibility.
Static booth with countdown — countdown, capture, then publish to QR and live gallery.
```

Keep cards visually consistent with current control-room design. Do not change routes, image assets, JS version loader, or menu behavior.

- [ ] **Step 4: Verify green**

Run: `node --test tests/landing-page.test.mjs`

Expected: PASS with 4 tests, 0 failures.

- [ ] **Step 5: Commit**

Run: `git add index.html tests/landing-page.test.mjs docs/superpowers/plans/2026-07-18-operator-landing-redesign.md; git commit -m "feat: clarify instant-sharing workflows"`
