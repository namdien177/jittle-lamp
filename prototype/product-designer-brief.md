# Jittle Lamp Product Brief For Redesign

## Short Answer

Jittle Lamp is a QA evidence tool.

It records a bug or test run, saves the video plus technical trace data, then lets a team review, discuss, share, and hand it to AI or automation.

```text
Record -> Save -> Review -> Discuss -> Share -> Debug -> Prove
```

## Product In One Table

| Area | What it does | Main user |
| --- | --- | --- |
| Browser extension | Records a browser tab or desktop screen | QA, engineer |
| Evidence web app | Lists, reviews, shares, and manages evidence | QA team |
| Quick view | Opens a local ZIP with no upload | Any reviewer |
| Organisations | Team, role, invite, and activity control | Admin, lead |
| Settings | Installs tools and creates tokens | Engineer, admin |
| Backend API | Stores evidence, files, comments, links, and tokens | System |

## Main Users

| User | Goal | Need |
| --- | --- | --- |
| QA tester | Show a bug clearly | Fast record, clear replay |
| Developer | Find the cause | Network, logs, cURL, AI prompt |
| QA lead | Review proof | Library, search, share, comments |
| Admin | Manage access | Organisations, roles, invites |
| Automation owner | Upload test proof | API token, ZIP format |
| Designer | Redesign workflow | Clear app map and user goals |

## Core Product Promise

Jittle Lamp makes one proof bundle:

| Bundle item | Meaning |
| --- | --- |
| `recording.webm` | Screen video |
| `session.archive.json` | Actions, logs, network, metadata |
| Thumbnail | Preview image in library |
| Comments | Team discussion |
| Share links | Org-scoped review links |
| AI prompt | Opens evidence to an LLM |

## Capture Flow

```text
User opens extension
  -> chooses Tab or Desktop
  -> may add session name
  -> may record tab audio
  -> starts capture
  -> interacts with app
  -> pause/resume or finish/abort
  -> save target is chosen by state
```

## Save Target Logic

| State | Finish result |
| --- | --- |
| Signed in to cloud | Upload to web app |
| Cloud not signed in, desktop companion online | Save to local output folder |
| Both unavailable | Download files through browser |
| Upload fails | Keep retry state |
| Abort | Discard recording |

## Extension Functions

| Function | Detail |
| --- | --- |
| Start recording | Starts one active session |
| Session name | User can name before or during recording |
| Target select | Active tab or full desktop/screen |
| Tab audio | Optional captured audio playback |
| Pause/resume | Stops video and event capture drift |
| Finish | Exports/upload evidence |
| Abort | Stops and discards |
| Retry upload | Retries failed cloud upload |
| Open evidence list | Opens web evidence library |
| Logout cloud | Clears extension cloud auth |
| Floating widget | In-page control bar |
| Move/collapse widget | Drag, compact, expand, close |
| Copy/open latest cloud link | After upload |

## Extension Captures

| Data | How |
| --- | --- |
| Video | `MediaRecorder` in offscreen document |
| Clicks | Content script |
| Inputs | Content script, typed value is limited/redacted |
| Keyboard | Content script, skips unsafe text keys |
| Selection | Content script |
| Navigation | History, hash, popstate, tab update |
| Console logs | Chrome debugger |
| Runtime errors | Chrome debugger |
| Network requests | Debugger, webRequest fallback, fetch/XHR probe |
| Headers | Request and response |
| Cookies | Debugger when available |
| Body | Best effort, capped/truncated |

## Privacy Notes

| Data type | Current behavior |
| --- | --- |
| Page URL | Query and hash stripped for page context |
| Network URL | Kept as captured |
| Typed values | Avoids raw field values in normal interaction events |
| Network bodies | May include sensitive data |
| Local quick view | Browser-only, no upload |
| Cloud upload | Requires signed-in extension session |

## Web App Route Map

| Route | Screen | Purpose |
| --- | --- | --- |
| `/` | Dashboard | Workspace overview |
| `/evidence` | Evidence library | Search, filter, review, manage |
| `/evidence/:id` | Cloud evidence viewer | Review one cloud record |
| `/share/:shareToken` | Shared evidence | Org-scoped shared review |
| `/quick-view` | Quick view | Open local ZIP in browser |
| `/organisations` | Organisation list | Create, join, switch |
| `/organisations/:id` | Members | Manage team |
| `/organisations/:id/roles` | Roles | Manage permissions |
| `/organisations/:id/invitations` | Invites | Codes, direct invites, requests |
| `/organisations/:id/activity` | Activity | Audit log |
| `/organisations/:id/library` | Org library | Evidence by organisation |
| `/organisations/:id/options` | Options | Leave/delete org |
| `/settings` | Settings overview | Account, active workspace, install |
| `/settings/ai-tokens` | AI tokens | Let LLM inspect evidence |
| `/settings/api-tokens` | API tokens | Upload automation ZIPs |
| `/join` | Join org | Redeem invite code |
| `/extension-auth` | Auth approval | Approve extension sign-in |
| `/desktop-auth` | Auth approval | Approve desktop sign-in |
| `/test-cases` | Coming soon | Test case library |
| `/documents` | Coming soon | Docs and reports |
| `/privacy` | Privacy | Public privacy page |

## Dashboard

| Area | Function |
| --- | --- |
| Stats | Evidence count, org count, last capture |
| Recent evidence | Opens latest records |
| Actions | Open local ZIP, browse evidence |
| Context | Shows active workspace |

## Evidence Library

| Function | Detail |
| --- | --- |
| Search | Title, type, id, creator |
| Filter by type | Dynamic source type list |
| Filter by people | Members in active org |
| Grid/table view | Two display modes |
| Pagination | 24 per page |
| Select visible | Bulk select |
| Bulk download | Downloads each selected ZIP |
| Bulk delete | Soft delete, purges after 30 days |
| Review | Opens evidence viewer |
| Rename | Changes evidence title |
| Share | Opens share dialog |
| Copy to workspace | Duplicates into another org |
| Transfer | Moves own evidence to another org |
| Download ZIP | Exports full evidence |
| Delete | Owner/admin/moderator rule |
| Pending badge | Shows not-ready evidence |

## Evidence Viewer

```text
Header
  title, recorded time, actions

Left pane
  video player
  discussion or notes

Right pane
  actions/logs/network tabs
  search
  filters
  detail drawer
```

| Function | Detail |
| --- | --- |
| Video playback | Video.js player |
| Seek by timeline | Click row seeks video |
| Auto-follow | Active event follows video time |
| Actions tab | Clicks, input, keyboard, selection, errors |
| Logs tab | Console log rows |
| Network tab | Requests with status |
| Network filters | All, XHR, Fetch, HTML, CSS, JS, Img, Font, Media, WS, Other |
| Search | Works across current tab |
| Detail drawer | Raw action/log/network detail |
| Copy cURL | Right-click network row |
| Copy response | Right-click network row |
| Merge actions | Select contiguous actions, right-click merge |
| Unmerge | Right-click merged group |
| Export reviewed ZIP | Includes merge annotations |
| Rename evidence | Cloud owner/manager only |
| Copy evidence | Cloud viewer only |
| Transfer evidence | Owner only |
| Copy to LLM | Creates/uses AI token, copies prompt |
| Discussion | Cloud/share viewer comments |
| Session notes | Local/ZIP viewer note area, read-only on web |

## Share Links

| Function | Detail |
| --- | --- |
| Create link | Permanent, 1 hour, 24 hours, 7 days, 30 days |
| Scope | Internal organisation only |
| Copy link | From create result or active list |
| Revoke | Stops link |
| History | Expired/revoked links |
| Restricted screen | Prompts user to join org |

## Quick View

| Function | Detail |
| --- | --- |
| Drop ZIP | Drag or file picker |
| Validate archive | Must contain `session.archive.json` and video |
| Local only | No upload |
| Review | Uses same viewer |
| Export | Can export reviewed ZIP |

## Organisations

| Screen | Functions |
| --- | --- |
| List | Create org, accept invite, set active, manage |
| Members | Search, role filter, paginate, change role, remove |
| Roles | Toggle permissions per role |
| Join approval | Require approval for invite links |
| Invitations | Create reusable code, direct invite, lock/unlock, delete |
| Join requests | Accept or reject |
| Activity | Filter by action, user, date |
| Library | View/delete evidence in an org |
| Options | Leave org, delete org if last admin/member |

## Roles And Permissions

| Role | Meaning |
| --- | --- |
| Admin | Fixed highest access |
| Moderator | Can manage review flows |
| Developer | Product/debug user |
| QA engineer | Capture/review user |

| Permission group | Examples |
| --- | --- |
| Evidence | View, download, comment, create, edit, delete, move |
| Invitations | Create, disable |
| Join requests | Manage |
| Roles | Manage |
| Members | Assign role, kick |
| Activity | View audit log |

## Settings

| Page | Function |
| --- | --- |
| Overview | Account, active workspace, install command, extension link |
| AI tokens | Create/revoke tokens for LLM evidence debug |
| API tokens | Create/revoke tokens for automation upload |

## AI Token Flow

```text
User creates token
  -> app shows token once
  -> user copies token or prompt
  -> LLM can fetch evidence session
```

Use case:

- "Debug this evidence."
- AI can load session archive and inspect captured request data.

## Automation Upload Flow

```text
External test runner
  -> creates ZIP
  -> POST /automation/evidences/zip
  -> evidence appears in workspace
```

| Rule | Detail |
| --- | --- |
| Token scope | Evidence upload |
| ZIP max size | 20 MB |
| Required files | `session.archive.json`, `recording.webm` |
| Source type | `automation-test` |

## Auth Flows

| Client | Flow |
| --- | --- |
| Web app | Clerk sign-in |
| Extension | Starts device auth, web app approves |
| Desktop | Starts device auth, web app approves |
| Extension refresh | Uses refresh token |

## Current Information Architecture

```text
Workspace
  Overview
  Evidence

Library
  Test cases (soon)
  Documents (soon)

Tools
  Quick view

Organisation
  Organisations
  Settings
```

## Important Product States

| State | User sees |
| --- | --- |
| Signed out | Sign-in required |
| Clerk missing | Sign-in not configured |
| No evidence | Empty state with open ZIP/upload prompt |
| Loading evidence | Status screen |
| Restricted share | Join org prompt |
| Upload failed | Retry from extension |
| Companion offline | Browser download fallback |
| Pending evidence | Pending badge |
| Deleted evidence | Soft delete, purge later |

## Coming Soon Areas

| Area | Current promise |
| --- | --- |
| Test cases | Suites, linked evidence, status |
| Documents | Test plans, reports, org-scoped sharing |
| Transfer organisation | Disabled action |
| Promote local to cloud | Mentioned in old plan, not current web flow |

## Designer Redesign Goals

| Goal | Why |
| --- | --- |
| Make record flow obvious | Capture is the product start |
| Separate local vs cloud clearly | Same viewer, different data rules |
| Treat evidence as a review object | Video + timeline + discussion |
| Make network debug less scary | Status, method, body, cURL need structure |
| Show trust and risk | Captured data can include sensitive payloads |
| Make team model visible | Active workspace affects upload target |
| Give AI/automation their own path | Tokens are powerful and risky |
| Keep quick view low-friction | It is the fastest review path |

## Redesign Must Keep

| Must keep | Reason |
| --- | --- |
| One active recording session | Extension only supports one |
| Finish vs abort distinction | Save vs discard |
| Pause/resume | Needed for clean evidence |
| Tab/desktop target switch | Core capture choice |
| Destination fallback | Cloud, companion, download |
| Actions/logs/network tabs | Core evidence model |
| Network detail drawer | Main debug value |
| Copy cURL and response | Developer handoff |
| Org-scoped share links | Security model |
| Role permissions | Team access model |
| Quick view local-only | Privacy promise |
| AI/API token warnings | Security risk |

## Best Top-Level Redesign Shape

```text
Capture
  record, upload state, extension install

Evidence
  library, review, share, discuss

Team
  orgs, members, roles, invites, activity

Tools
  quick view, AI token, API token

Settings
  account, install, active workspace
```

## Source Evidence

| Topic | Code |
| --- | --- |
| Web routes | `apps/evidence-web/src/router.tsx` |
| Library | `apps/evidence-web/src/pages/evidence-library.tsx` |
| Viewer | `apps/evidence-web/src/evidence-viewer-content.tsx` |
| Shared viewer UI | `packages/viewer-react/src/viewer-modal/` |
| Quick view | `apps/evidence-web/src/pages/quick-view.tsx` |
| Organisations | `apps/evidence-web/src/pages/organisations.tsx` |
| Settings | `apps/evidence-web/src/pages/settings.tsx` |
| Extension popup | `apps/extension/src/popup.ts` |
| Extension background | `apps/extension/src/background.ts` |
| Extension content widget | `apps/extension/src/content.ts` |
| Offscreen recorder | `apps/extension/src/offscreen.ts` |
| Network probe | `apps/extension/src/network-probe.ts` |
| Archive schema | `packages/shared/src/session.ts` |
| Backend evidence API | `apps/backend/src/routes/evidences.ts` |
| Share links | `apps/backend/src/routes/share-links.ts` |
| Automation upload | `apps/backend/src/routes/automation.ts` |
