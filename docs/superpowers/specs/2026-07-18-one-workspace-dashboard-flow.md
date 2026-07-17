# PoloPro One-Workspace Dashboard Flow Design

## Goal

Replace New Setup, Edit Setup, and View Setup as primary modes with one event workspace that follows an operator's event lifecycle.

## Primary flow

1. Start a new event or open an existing event from one event picker.
2. Configure event details, booth settings, templates, and branding.
3. Publish or save setup.
4. Use Share live for QR codes, gallery links, booth links, QR downloads, and photo management.
5. Use Gallery to inspect and manage delivered photos.

## Work zones

- Configure: event details, gallery branding, and publish/save action.
- Booths: booth count, templates, and operator capture settings.
- Share live: QR codes, gallery links, booth links, download QR actions, and manage-photo entry point.
- Gallery: existing photo-management view.

## State actions

- New event: Create event.
- Existing changed event: Save changes.
- Existing event: View QR codes, Open gallery, and Manage photos.
- Destructive event action moves into a compact danger area.

## Behavior constraints

- Preserve existing IDs, inline handlers, API calls, field restrictions, and modal behavior.
- Do not reset event form when navigating between work zones.
- Existing publish, update, delete, QR, and gallery operations remain functional.
- No backend changes or new dependencies.

## UX requirements

- A single event selector remains visible and is used by every zone.
- Replace mode labels with task labels: Configure, Booths, Share live, Gallery.
- Explain locked controls inline rather than hiding whole concepts.
- Keep keyboard focus, reduced-motion fallback, responsive layout, dark/light themes, and touch-sized controls.

## Verification

- Add a static test for new workspace labels and removal of visible legacy mode labels.
- Verify red before implementation and green after.
- Run dashboard and landing contract suites.
