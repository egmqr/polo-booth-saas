# PoloPro Dashboard Command Center Design

## Goal

Reshape existing dashboard into operator command center for building, running, sharing, and delivering event galleries without changing backend behavior.

## Audience

Photo booth operators using roving photography, on-site studio photography, or static countdown booths. All workflows need instant QR sharing and a live web gallery.

## Information architecture

1. Utility bar: current event switcher, settings, theme, apps, and logout.
2. Event command header: create event, active-event identity, and live-status context.
3. Work zones: Setup, Booth, Sharing, Gallery. Zones create visual hierarchy over existing form sections; current controls and IDs remain intact.
4. Sharing status: visible QR/gallery delivery surface, gallery link, photo-management action, and gallery controls.
5. Existing modals stay functional and unchanged except optional visual alignment.

## Visual direction

Continue operator-control-room identity: dark graphite panels, electric mint active state, restrained coral for live status, monospace utility labels, and Space Grotesk headings. Use one bold structural change: a left rail/work-zone layout on desktop that collapses to a clear horizontal control strip or stacked sections on mobile.

## UX requirements

- Preserve every existing DOM ID, inline event handler, backend API call, field, and modal behavior.
- Do not add dependencies or change server/client business logic.
- Event selection and creation must remain immediately reachable.
- Sharing and gallery delivery must remain discoverable from every live event.
- Provide visible keyboard focus, reduced-motion fallback, responsive layout, and touch-sized controls.
- Existing dark/light modes continue to work.

## Verification

- Add a static Node contract test for command-center landmarks, work-zone labels, current critical IDs, focus, and reduced-motion CSS.
- Verify the test fails before markup changes and passes after.
- Inspect desktop and mobile render if local browser access permits.
