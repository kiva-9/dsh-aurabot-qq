# Memory fact domain (work package 5)

`src/features/memory.js` re-exports this domain. `createMemoryStore(storage)` or
`createMemoryStore({storage, dsh, getConfig, hub, ...})` uses the caller's SQLite
connection and transaction API. It runs `ensureSchema(storage)` idempotently and
does not change `PRAGMA user_version` or close the caller's connection.

`await memory.dispose()` / `await memory.stop()` logically cancels and settles all
extraction/dedup/profile workers before returning; repeated disposal shares one
promise. Call it before closing SQLite or discarding a module during hot reload.
Callbacks receive an AbortSignal. The existing host askModel transport does not
expose a physical abort contract, so its late network response is discarded by a
cancellation race and cannot access SQLite. `getAccount()` guards every awaited
automatic result and its transaction; the built-in module supplies the configured
account/current transport account and rejects stale tool closures. Canceled work
releases its lease to pending without advancing recv_seq. Manual panel reads of
explicit historic scopes remain available until service disposal.

## Scope and authorization boundary

Every public content read/write requires an explicit scope:

```js
const scope = { account: '20000002', chat: 'group:777', persona: '' }
```

Account/chat are never inferred from a person's QQ number. Facts normally use
`persona:''`. A viewer carrying the current persona can see general facts plus
facts restricted to that persona. Experiences require a persona; profile caches
and overrides have independent exact viewer scope keys. Module context resolves
the frozen persona with `hub.turnPersona(sessionId)?.personaId`. Tool fact writes
and automatic extraction deliberately use the general fact scope.

Shared reads require a current `memory.shareGroups` entry, e.g.
`{id:'friends', account:'20000002', chats:['group:777','group:888'], categories:['fact','profile']}`.
Categories are independent (`experience` is separate). Sharing is not transitive
and never grants write authority. Every source audience must permit the viewer;
mixed evidence uses the intersection. Optional `getPolicy()` replaces the config
policy for integrations with revisioned policy stores.

The module's panel routes assume the host's authenticated administrative API.
These are **not** untrusted chat tools. Only remember/recall tools are registered;
their scope and speaker/source IDs come from transport/request context. No global
list/recall/profile fallback exists. Old unscoped `contextFor`/`topicScore` return
empty/zero, and unscoped `lastConsolidate` returns null for host compatibility.

## Creating, editing and correcting

`create(input)` throws typed errors; compatibility `add(input)` returns
`{ok:false,code,message}` on errors. Successful writes include `scope/account/chat`.
Structured facts require `subject,predicate,value,speakerId,polarity,modality,
conditions,eventTime,validFrom,validTo,stability`. All times are integer Unix
milliseconds or null. Null conditions mean unknown; `[]` means no conditions.

```json
{
  "scope":{"account":"20000002","chat":"group:777","persona":""},
  "text":"小明喜欢咖啡",
  "subject":"10000001","predicate":"likes","value":"咖啡",
  "speakerId":"10000001","polarity":"positive","modality":"asserted",
  "conditions":[],"eventTime":null,"validFrom":null,"validTo":null,
  "stability":"stable",
  "manualEvidence":{
    "kind":"manual","text":"管理员核对原话：小明喜欢咖啡",
    "speakerId":"10000001","actorId":"admin"
  }
}
```

For existing chat evidence, replace `manualEvidence` with
`evidenceMessageIds:['SQLite-internal-message-id']`. Caller-supplied platform IDs
are not internal message IDs. Speaker must match at least one source. Bot output,
foreign account/chat messages and recalled/deleted messages cannot substantiate
new user facts. Existing `evidenceIds` may be used only if currently visible.

Optional fields: `aboutName`, `tags`, `importance` (0..1), `slot` (`single`/`multi`,
default multi), `profileSection`, `extractorVersion`. New status is active;
`supersedes` may only be assigned through `correct`. Modality is one of asserted,
reported, hypothetical, plan, joke, uncertain. Stability is stable, temporal,
uncertain; non-asserted claims cannot be stable.

Edit request:

```js
memory.update(id, {text:'小明喜欢茶', value:'茶'}, {
  scope, expectedRevision: 1, actorId:'admin', reason:'核对后的更正',
  manualEvidence:{kind:'manual', text:'确认新说法为喜欢茶', speakerId:'10000001', actorId:'admin'},
})
```

`correct(id,replacement,{scope,expectedRevision,actorId,reason})` creates a new
fact and supersedes the old one with a full audit. Replacement carries its own
evidence. Other speakers' reports cannot supersede a direct assertion.
`retract/remove/restore/approve(id,{scope,actorId,reason,...})` are separate actions.
All edits preserve audit; `update` requires optimistic revision matching.

`addEvent({scope:{account,chat,persona},text,sourceId,confirmed:true,eventTime?,about?,...})`
is the compatibility entry for delivered actions. It requires a successful receipt
ID, treats an identical receipt replay idempotently and refuses unscoped calls.
Unconfirmed attempts and unknown legacy sources do not become public experiences.

## Deletion and evidence review

Remove writes fact/content tombstones and source tombstones in one transaction.
Other local facts depending on the same deleted source are retracted for review.
Late extraction/append attempts cannot resurrect that source. Restore moves the
record to quarantined and never publishes it. A deliberate recovery uses:

1. `restore(factId,{scope,actorId,reason})`.
2. `evidenceReview(factId,{scope})` to obtain source IDs/revisions (no deleted text).
3. `approveEvidence(evidenceId,{scope,expectedRevision,approved:true,actorId,reason})`
   for each intended source. Changed/missing/recalled messages are rejected.
4. `approve(factId,{scope,approved:true,actorId,reason})`.

Tombstones remain after approval, so replayed extraction still cannot use the old
message. `refreshEvidence` for an edited live message re-quarantines all dependents;
it does not silently validate old fact text. `audit` is explicit owner-scope admin
history; automatic reads never use audit/history as facts.

## Extraction and profiles

`enqueue(scope)` persists the latest receive watermark. `tick({scope})` evaluates
new message count OR elapsed time since last successful commit, requiring new
messages. `consolidate({scope})` forces an incremental pass. Count/interval config:
`memory.extraction.{minMessages,intervalMs,maxBatchMessages,maxChars}` (old internal
alias `batchMessages` also accepted). Actual transaction batches cap at 100
messages; a long individual message is fully split into fragments before its
checkpoint can commit. Facts, evidence, summary and checkpoint commit atomically.
Failures retain pending/error and never advance the failed interval. No raw
message or old chat log is removed. One persisted lease per scope prevents overlap;
repeated triggers coalesce into a durable watermark. `status`, `recentPending`,
`episodes`, `registeredScopes` are available for operations/panel use.

Default extraction and dedup call the existing memory model role through askModel.
Tests may inject `extract({messages,scope})` and `deduplicate({facts,candidates,...})`.
Output is strict JSON, not a permissive text/regex parser. Dedup requires one
keep/reuse/possible_duplicate decision per input. Batch predecessors have IDs
`batch:<inputId>`. Candidates are scope-filtered and reuse verifies structural
equality; possible_duplicate preserves a separate fact and candidate relationship.

`buildProfile(subject,{scope})` produces six evidence-linked sections: identity,
relationships, stableFacts, preferences, recentInteractions, uncertain. The default
builder is deterministic and uses confirmed facts directly; optional
`generateProfile(input)` must return evidence-linked structured sections and cannot
promote plans/jokes/reports into stable entries. Module context prepares up to four
current speakers' profiles. Input is bounded by `memory.profiles.maxFacts` (default
60, max 100). Fingerprints include content/revisions, validity, scope/policy,
aliases/overrides, model/template versions. Concurrent builds share one task;
commit rechecks inputs. Default profile injection excludes uncertain entries.

`profileOf` includes safe `override:{aliases,entries,revision}`.
`getOverrides(subject,{scope})` works even without a profile. Its revision remains
available after deletion, while old source text is suppressed. `setOverrides`
requires `{aliases,entries:[{section,text,factIds}]}` and
`{scope,expectedRevision,actorId,reason}`. Stored source signatures prevent stale
manual overrides from resurfacing after evidence edits. Auto rebuilds preserve
still-valid manual confirmations.

## Panel routes

GET parameters: `account,chat,persona` (default empty), plus route-specific IDs.
POST payloads use a scope object. Route errors return `{ok:false,code,message}`.

| Route | Request / response |
| --- | --- |
| GET `/memories` | `q?,includeInactive?,limit?`; items, stats, review, scope/account/chat |
| POST `/memory/add` | complete fact + evidence; id/item |
| POST `/memory/update` | id/patch/expectedRevision/actorId/reason + new evidence |
| POST `/memory/correct` | id/replacement/expectedRevision/actorId/reason |
| POST `/memory/delete`, `/memory/retract`, `/memory/restore`, `/memory/approve` | id/actorId/reason; approval also approved:true |
| POST `/memory/scope` | id/targetScope/expectedRevision/actorId/reason; cannot broaden source audience |
| GET `/memory/evidence` | id=factId; live evidence items |
| GET `/memory/evidence/review` | id=factId; source review metadata only |
| POST `/memory/evidence/delete`, `/refresh`, `/approve` | id=evidenceId and audit metadata; approve also expectedRevision/approved:true |
| GET `/memory/audit` | id=factId; ordered audit items |
| GET `/memory/recalls` | scoped recent recall decisions; deleted hits filtered |
| GET `/memory/extraction` | checkpoint, pending, episodes |
| POST `/memory/extract` | scope; processed/added/reused/checkpoint |
| GET `/profiles` | list; optional includeUncertain=true |
| GET `/profiles/override` | subject (qq alias supported); override with current revision |
| POST `/profiles/rebuild` | subject/scope; profile |
| POST `/profiles/save` | subject/override/expectedRevision/actorId/reason |
| GET `/memory/quarantine` | items; includeUnassigned=true also returns unassigned and migration reports |
| POST `/memory/quarantine/import` | payload/sourceKey?; IDs remain quarantined |
| POST `/memory/quarantine/approve` | id/fact/approved:true/actorId/reason; explicit destination scope + fresh reviewed evidence |
| POST `/memory/import`, `/memory/import/commit` | legacy compatibility aliases; always quarantine |

## Legacy and indexing integration

At initialization the domain reads only known `memories.json` paths beside the DB
and in its `legacy/` subfolder (or under explicit `legacyDir`). Each source imports
transactionally once, preserving individual facts/profiles/styles and source files.
Missing files are not marked done; invalid JSON reports pending and retries next
initialization. Rows with unknown origins have `scope/account/chat=null` in the
administrative unassigned view. Claims of scope inside old JSON are never trusted.
No model, recall, profile or context automatically reads quarantine rows.

Index adapter hooks, all synchronous:

- `revision(scope)` is the local domain mutation revision.
- `visibilityStamp(scope)` hashes current policy plus visible origin revisions,
  including general facts and explicitly shared scopes.
- `getFactsByIds(ids,{scope,includeInactive?,at?})` (max 200 IDs) revalidates all
  sources, status, time and tombstones. Missing/invisible records are omitted.
- `list({scope,limit})` and `list(scope,{limit})` supply visible facts with revisions,
  evidence hashes and source IDs (default 300, maximum 5000 results, at most 20000
  SQL candidates per call). Rank candidates only after scope filtering; revalidate IDs before
  returning/injecting results. Source rows may also change outside this domain,
  so a matching stamp is never a substitute for the final getFactsByIds check.

- `page(scope,{cursor?,limit?,subject?,category?,statuses?,includeInactive?,
  currentOnly?,ownScope?,order?})` returns `{items,nextCursor,done,scanned,
  visibilityStamp,revision,scope,account,chat,persona}`. Default page size 100;
  maximum 1000 SQL candidates. Continue while `nextCursor` is non-null, including
  empty result pages whose evidence was suppressed. `order` is `created` (default)
  or `updated`, descending with an ID tie-breaker. `STALE_CURSOR` requires a new
  enumeration after source/policy revisions; reusing a cursor with different
  scope/query returns `INVALID_CURSOR`.

Pages prefilter account, authorized chats per category, persona, status and subject
in SQL using scoped indexes. Fact/evidence/message/tombstone checks run in bounded
batches, followed by the final audience intersection. Chinese lexical indexing is
cached for a bounded 5000-candidate corpus per scope, with visible revision, policy
and time-boundary invalidation (LRU: at most 8 scopes / 20000 documents). A warm
query rechecks ranked hits without fetching/rebuilding the corpus. Direct host
message edits/deletes also advance source revisions. Transaction-local corpora are
never cached across rollback. This is bounded candidate retrieval, not exhaustive
keyword search over arbitrarily large histories; use `page` to enumerate further.
`lexicalCacheStats()` exposes build/hit/cache-size diagnostics. The opt-in synthetic
100k benchmark is `AURABOT_MEMORY_BENCH=1 node --test test/memory-query-benchmark.test.js`;
it uses a temporary database, not production data or a provider.

No vector/embedding file is implemented or edited here. Main integration still
owns the host receive hook (`enqueue`/`tick` for never-replied-to chats), core
migration registration/backup recovery, external module call-site scopes and the
panel. Expression learning/global self-style persistence is a separate domain;
the unsafe global style/insight endpoints were removed, not replaced with stubs.
