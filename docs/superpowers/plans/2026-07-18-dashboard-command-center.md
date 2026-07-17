# PoloPro Dashboard Command Center Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn dashboard into an operator command center without changing existing operational behavior.

**Architecture:** Keep all dashboard logic, IDs, inline handlers, and existing form content. Add semantic command-center wrappers and CSS overrides around existing event controls; validate structural promises with a Node built-in static test.

**Tech Stack:** Static HTML, CSS, vanilla JavaScript, Node.js built-in `node:test`.

## Global Constraints

- Preserve every existing DOM ID, inline event handler, API call, form field, and modal.
- Do not add dependencies or modify backend code.
- Maintain dark and light themes, keyboard focus, reduced-motion support, responsive layout, and 44px touch controls.
- Make Event Setup, Booth, Sharing, and Gallery visible work zones.

---

## File map

- `dashboard/index.html`: dashboard markup, inline CSS, and existing client behavior.
- `tests/dashboard-command-center.test.mjs`: static contract for hierarchy and behavior preservation.

### Task 1: Define command-center contract

**Files:**

- Create: `tests/dashboard-command-center.test.mjs`
- Test: `tests/dashboard-command-center.test.mjs`

**Interfaces:** Reads `dashboard/index.html` through `fs.readFile`; runs with `node --test tests/dashboard-command-center.test.mjs`.

- [ ] **Step 1: Write failing test**

```js
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const page = await readFile(new URL('../dashboard/index.html', import.meta.url), 'utf8');

test('exposes command-center work zones without removing critical controls', () => {
  for (const zone of ['Event Setup', 'Booth', 'Sharing', 'Gallery']) {
    assert.match(page, new RegExp(`data-work-zone="${zone}"`));
  }
  for (const id of ['eventSelect', 'eventName', 'eventId', 'manageModal', 'dashboardWindowsDownload', 'dashboardAndroidDownload']) {
    assert.match(page, new RegExp(`id="${id}"`));
  }
});

test('includes dashboard accessibility and responsive safeguards', () => {
  assert.match(page, /:focus-visible/);
  assert.match(page, /prefers-reduced-motion: reduce/);
  assert.match(page, /command-center/);
});
```

- [ ] **Step 2: Verify red**

Run: `node --test tests/dashboard-command-center.test.mjs`

Expected: FAIL because command-center work-zone markers and safeguards do not yet exist.

### Task 2: Build command-center hierarchy

**Files:**

- Modify: `dashboard/index.html`
- Test: `tests/dashboard-command-center.test.mjs`

**Interfaces:** Existing event selection uses `eventSelect`; current event identifier uses `eventId`; app downloads use `dashboardWindowsDownload` and `dashboardAndroidDownload`; management modal remains `manageModal`.

- [ ] **Step 1: Add command-center markup**

Wrap existing operational content in a `.command-center` layout. Keep existing elements in place and add labels only:

```html
<main class="command-center">
  <section class="command-header">…existing event picker and event actions…</section>
  <nav class="work-zone-rail" aria-label="Event work zones">
    <a href="#setup-zone">Setup</a><a href="#booth-zone">Booth</a><a href="#sharing-zone">Sharing</a><a href="#gallery-zone">Gallery</a>
  </nav>
  <section id="setup-zone" class="work-zone" data-work-zone="Event Setup">…existing event setup…</section>
  <section id="booth-zone" class="work-zone" data-work-zone="Booth">…existing booth settings…</section>
  <section id="sharing-zone" class="work-zone" data-work-zone="Sharing">…existing QR/gallery controls…</section>
  <section id="gallery-zone" class="work-zone" data-work-zone="Gallery">…existing photo management…</section>
</main>
```

Move no IDs and change no `onclick`, `onchange`, or backend binding.

- [ ] **Step 2: Add focused CSS overrides**

Add command-center tokens and layout at end of existing style block. Desktop uses a narrow work-zone rail plus grouped cards; mobile stacks zones and preserves controls. Use `:focus-visible` with a clear mint outline and a `prefers-reduced-motion: reduce` block. All action controls use at least 44px minimum height.

- [ ] **Step 3: Verify green**

Run: `node --test tests/dashboard-command-center.test.mjs`

Expected: PASS with 2 tests, 0 failures.

- [ ] **Step 4: Verify existing landing tests**

Run: `node --test tests/landing-page.test.mjs`

Expected: PASS with 4 tests, 0 failures.

- [ ] **Step 5: Commit**

Run: `git add dashboard/index.html tests/dashboard-command-center.test.mjs; git commit -m "feat: add dashboard command center"`

### Task 3: Final verification

**Files:**

- Test: `tests/dashboard-command-center.test.mjs`
- Test: `tests/landing-page.test.mjs`

- [ ] **Step 1: Run all local contract tests**

Run: `node --test tests/*.test.mjs`

Expected: PASS with 6 tests, 0 failures.

- [ ] **Step 2: Check scope**

Run: `git status --short`

Expected: clean status after commit.

## Plan self-review

- Coverage: tasks protect key dashboard IDs, required work zones, accessibility safeguards, and landing regression.
- Scope: dashboard markup/style only; no backend or behavior changes.
- No placeholders or unbound interfaces.
