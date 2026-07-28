import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const page = await readFile(new URL('../dashboard/index.html', import.meta.url), 'utf8');

test('preserves critical operator controls', () => {
  for (const id of ['eventSelect', 'eventName', 'eventId', 'boothCount', 'boothTemplateList', 'pageTitle', 'boothList', 'manageModal', 'dashboardWindowsDownload', 'dashboardAndroidDownload']) {
    assert.match(page, new RegExp(`id="${id}"`));
  }
});

test('includes dashboard accessibility and responsive safeguards', () => {
  assert.match(page, /:focus-visible/);
  assert.match(page, /prefers-reduced-motion: reduce/);
  assert.match(page, /command-center/);
});

test('uses boxed segments and context actions', () => {
  assert.match(page, /\.dashboard-segment \{[^}]*border: 1px solid var\(--border\);/);
  assert.match(page, /\.dashboard-segment h2 \{[^}]*font-size: 18px;/);
  assert.match(page, /\.workspace-toolbar \{[^}]*display: grid;/);
  assert.match(page, /\.top-navbar \{[^}]*max-width: 1180px;/);
  assert.doesNotMatch(page, /\.dashboard-segment \{[^}]*border-top:/);
});

test('places same-size event actions beside each other above the full-width selector', () => {
  assert.match(page, /\.workspace-toolbar \{[^}]*display: grid;/);
  assert.match(page, /\.event-picker \{[^}]*width: 100%;[^}]*max-width: none;/);
  assert.match(page, /\.event-picker select \{[^}]*width: 100%;/);
  assert.match(page, /\.workspace-actions \.action-btn, \.workspace-actions \.file-btn \{[^}]*flex: 0 0 124px;[^}]*width: 124px;[^}]*min-height: 44px;/);
  const toolbar = page.slice(page.indexOf('<div class="workspace-toolbar"'), page.indexOf('<div id="editFormFields"'));
  assert.ok(toolbar.indexOf('class="workspace-actions"') < toolbar.indexOf('class="form-group event-picker"'));
});

test('keeps the workspace empty until an event is selected or created', () => {
  assert.match(page, /onclick="setMode\('new', true\)"/);
  assert.match(page, /function setMode\(mode, activateWorkspace = false\)/);
  assert.match(page, /editFormFields'\)\.style\.display = activateWorkspace \? 'block' : 'none';/);
  assert.match(page, /generateBtn'\)\.style\.display = activateWorkspace \? 'block' : 'none';/);
  assert.match(page, /-- Select an event --/);
});

test('separates each visible workspace container', () => {
  assert.match(page, /#editFormFields > \.dashboard-segment \+ \.dashboard-segment, #viewContainer \{ margin-top: 24px; \}/);
});

test('groups the workspace into Event, Web Gallery, and Manage', () => {
  for (const segment of ['Event', 'Web Gallery', 'Manage']) {
    assert.match(page, new RegExp(`data-dashboard-segment="${segment}"`));
  }
  assert.doesNotMatch(page, /class="work-zone-rail"/);
});

test('uses one event workspace instead of visible setup modes', () => {
  assert.match(page, />\s*New event\s*</);
  assert.doesNotMatch(page, />\s*New Setup\s*<\/button>/);
  assert.doesNotMatch(page, />\s*Edit Setup\s*<\/button>/);
  assert.doesNotMatch(page, />\s*View Setup\s*<\/button>/);
});

test('renders Share live when an existing event opens', () => {
  assert.match(page, /if \(currentMode === 'view' \|\| currentMode === 'edit'\)/);
  assert.doesNotMatch(page, /else if \(currentMode === 'view' \|\| currentMode === 'edit'\)/);
});

test('defaults gallery search and time off, then clears Manage after deletion', () => {
  assert.match(page, /id="boothShowSearchBar">/);
  assert.match(page, /id="boothShowTime">/);
  assert.match(page, /boothShowSearchBar'\)\.checked = false;/);
  assert.match(page, /boothShowTime'\)\.checked = false;/);
  assert.match(page, /viewContainer'\)\.style\.display = 'none';[\s\S]*?setMode\('new'\);/);
});

test('uses compact grouped gallery switches', () => {
  assert.match(page, /\.gallery-control-panel \{/);
  assert.match(page, /\.gallery-toggle-row input\[type="checkbox"\]:checked/);
  assert.match(page, /class="gallery-control-panel"/);
  assert.match(page, /class="gallery-toggle-row" id="communityEnableRow"/);
  assert.match(page, /class="gallery-toggle-row branding-switch"/);
});

test('hides virtual booth settings for events without a virtual booth', () => {
  assert.match(page, /communityGroup'\)\.style\.display = 'none';/);
  assert.match(page, /communityGroup'\)\.style\.display = details\.enableCommunity === true \? 'block' : 'none';/);
  assert.match(page, /communityGroup'\)\.style\.display = 'block';/);
});
